import { describe, expect, it } from 'vitest';
import type { CheckoutTarget } from '../../api/gen/CheckoutTarget';
import type { Expect } from '../../api/gen/Expect';
import { readCommit } from '../engine/read/commitText';
import { addWorktree, fakeCtx, makeTestRepo, type TestRepo } from '../engine/read/testkit';
import { branchConfig } from '../engine/write/config';
import { writeCommitObject } from '../engine/write/objects';
import { readHead } from '../engine/write/refs';
import { mainWt } from '../engine/write/seam';
import { checkoutHandlers } from './checkout';

const NO: Expect = { head: null, refs: {} };

/** main at `next` (a.txt "b"), feature at `base` (a.txt "a"), an origin remote. */
async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  const base = await t.commit('Base');
  await t.write('a.txt', 'b\n');
  const next = await t.commit('Next');
  await t.branch('feature', base);
  const cfg = `${t.repo.gitdir}/config`;
  t.memfs.writeFileSync(cfg, `${t.memfs.readFileSync(cfg, 'utf8') as string}[remote "origin"]\n\turl = /demo/.origins/test.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return { t, base, next, ctx: fakeCtx(t.repo), wt: mainWt(t.repo) };
}

const setRemote = (t: TestRepo, branch: string, oid: string) => {
  t.memfs.mkdirpSync(`${t.repo.gitdir}/refs/remotes/origin`);
  t.memfs.writeFileSync(`${t.repo.gitdir}/refs/remotes/origin/${branch}`, `${oid}\n`);
};
const child = async (t: TestRepo, parent: string, of: string, message: string) =>
  writeCommitObject(t.repo, { tree: (await readCommit(t.repo, of)).tree, parents: [parent], author: 'Ada Lovelace <ada@example.com> 1767225600 +0000', committer: 'Ada Lovelace <ada@example.com> 1767225600 +0000', message: `${message}\n` });
const co = (ctx: ReturnType<typeof fakeCtx>, dir: string, target: CheckoutTarget, expect: Expect = NO, onDiverged?: 'reset') =>
  checkoutHandlers.checkout({ repo: 1, worktree: dir, target, expect, ...(onDiverged ? { onDiverged } : {}) }, ctx);

describe('checkout', () => {
  it('switches to a local branch, and checking out the branch already here does nothing', async () => {
    const { t, base, ctx, wt } = await repo();
    const r = await co(ctx, t.dir, { kind: 'branch', name: 'feature' });
    expect([r.outcome, readHead(wt), t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), r.journal.undo?.label, ctx.writes.journal(t.dir).undoTop()?.undo]).toEqual([{ status: 'done', branch: 'feature' }, { branch: 'feature', oid: base }, 'a\n', 'checkout feature', 'switch']);
    expect((await co(ctx, t.dir, { kind: 'branch', name: 'feature' })).outcome).toEqual({ status: 'done', branch: 'feature' });
    expect(ctx.writes.journal(t.dir).undo.length).toBe(1);
    await expect(co(ctx, t.dir, { kind: 'branch', name: 'nope' })).rejects.toMatchObject({ kind: 'NotFound', message: 'No branch nope' });
  });

  it('creates a tracking branch for a remote branch without a local one', async () => {
    const { t, base, ctx, wt } = await repo();
    setRemote(t, 'topic', base);
    await co(ctx, t.dir, { kind: 'remote', remote: 'origin', branch: 'topic' });
    expect([readHead(wt), branchConfig(t.repo.demo!, 'topic')]).toEqual([{ branch: 'topic', oid: base }, new Map([['branch.topic.remote', ['origin']], ['branch.topic.merge', ['refs/heads/topic']]])]);
    expect(ctx.writes.journal(t.dir).undoTop()?.config.map((c) => c.key)).toEqual(['branch.topic.remote', 'branch.topic.merge']);
  });

  it('refuses a remote branch of no configured remote whole: no branch, no config, no move, no entry', async () => {
    const { t, base, next, ctx, wt } = await repo();
    t.memfs.mkdirpSync(`${t.repo.gitdir}/refs/remotes/stray`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/refs/remotes/stray/topic`, `${base}\n`);
    await expect(co(ctx, t.dir, { kind: 'remote', remote: 'stray', branch: 'topic' })).rejects.toMatchObject({ kind: 'Other', message: "cannot set up tracking information; starting point 'refs/remotes/stray/topic' is not a branch" });
    expect([readHead(wt), t.memfs.existsSync(`${t.repo.gitdir}/refs/heads/topic`), branchConfig(t.repo.demo!, 'topic').size, t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), ctx.writes.journal(t.dir).undo.length]).toEqual([{ branch: 'main', oid: next }, false, 0, 'b\n', 0]);
  });

  it('fast-forwards a behind branch, then merges ff-only when it is checked out here (Rewind)', async () => {
    const { t, next, ctx, wt } = await repo();
    setRemote(t, 'feature', next);
    await co(ctx, t.dir, { kind: 'remote', remote: 'origin', branch: 'feature' });
    expect(readHead(wt)).toEqual({ branch: 'feature', oid: next });
    const ahead = await child(t, next, next, 'Ahead');
    setRemote(t, 'feature', ahead);
    await co(ctx, t.dir, { kind: 'remote', remote: 'origin', branch: 'feature' });
    expect([readHead(wt), ctx.writes.journal(t.dir).undoTop()?.undo]).toEqual([{ branch: 'feature', oid: ahead }, 'rewind']);
  });

  it('asks when diverged, then resets only to the commits it showed', async () => {
    const { t, base, next, ctx, wt } = await repo();
    const side = await child(t, base, base, 'Side');
    setRemote(t, 'main', side);
    const asked = await co(ctx, t.dir, { kind: 'remote', remote: 'origin', branch: 'main' });
    expect(asked.outcome).toEqual({ status: 'diverged', local: 'main', remote: 'origin/main', ahead: 1, behind: 1, localOid: next, remoteOid: side });
    await expect(co(ctx, t.dir, { kind: 'remote', remote: 'origin', branch: 'main' }, NO, 'reset')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Reset main needs the commits the question showed' });
    for (const one of [{ 'refs/heads/main': next }, { 'refs/remotes/origin/main': side }] as Record<string, string>[])
      await expect(co(ctx, t.dir, { kind: 'remote', remote: 'origin', branch: 'main' }, { head: null, refs: one }, 'reset')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Reset main needs the commits the question showed' });
    expect([readHead(wt), ctx.writes.journal(t.dir).undo.length]).toEqual([{ branch: 'main', oid: next }, 0]);
    const pinned: Expect = { head: null, refs: { 'refs/heads/main': next, 'refs/remotes/origin/main': side } };
    await co(ctx, t.dir, { kind: 'remote', remote: 'origin', branch: 'main' }, pinned, 'reset');
    expect([readHead(wt), t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), ctx.writes.journal(t.dir).undoTop()?.undo]).toEqual([{ branch: 'main', oid: side }, 'a\n', 'rewind']);
  });

  it('refuses a branch checked out in another worktree, before asking anything', async () => {
    const { t, base, ctx } = await repo();
    await addWorktree(t, 'side', 'feature');
    await expect(co(ctx, t.dir, { kind: 'branch', name: 'feature' })).rejects.toMatchObject({ detail: { kind: 'checkedOutElsewhere', branch: 'feature', worktree: '../wt-side' } });
    setRemote(t, 'feature', await child(t, base, base, 'Elsewhere'));
    await expect(co(ctx, t.dir, { kind: 'remote', remote: 'origin', branch: 'feature' })).rejects.toMatchObject({ detail: { kind: 'checkedOutElsewhere' } });
  });

  it('detaches at a short id, labelled by the resolved commit, and refuses what is not one', async () => {
    const { t, base, ctx, wt } = await repo();
    const r = await co(ctx, t.dir, { kind: 'detached', oid: base.slice(0, 9) });
    expect([r.outcome, readHead(wt), r.journal.undo?.label]).toEqual([{ status: 'done', branch: null }, { branch: null, oid: base }, `checkout ${base.slice(0, 7)}`]);
    await expect(co(ctx, t.dir, { kind: 'detached', oid: 'main' })).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Not a commit id: main' });
    await expect(co(ctx, t.dir, { kind: 'detached', oid: '0000000' })).rejects.toMatchObject({ kind: 'NotFound', message: 'No commit 0000000' });
    t.memfs.writeFileSync(`${t.repo.gitdir}/MERGE_HEAD`, `${base}\n`);
    await expect(co(ctx, t.dir, { kind: 'branch', name: 'main' })).rejects.toMatchObject({ kind: 'InProgress', message: 'A merge is in progress' });
  });
});
