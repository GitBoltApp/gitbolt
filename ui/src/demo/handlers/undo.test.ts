import { describe, expect, it, vi } from 'vitest';
import { blobId } from '../engine/read/bytes';
import { addWorktree, fakeCtx, makeTestRepo } from '../engine/read/testkit';
import { branchConfig } from '../engine/write/config';
import { readHead, setHead } from '../engine/write/refs';
import { mainWt } from '../engine/write/seam';
import { statusEntries } from '../engine/write/status';
import { branchHandlers } from './branches';
import { checkoutHandlers } from './checkout';
import { commitHandlers } from './commit';
import { discardHandlers } from './discard';
import { mergeHandlers } from './merge';
import { resetHandlers } from './reset';
import { stageHandlers } from './stage';
import { stashHandlers } from './stash';
import { undoHandlers } from './undo';
import { worktreeFileHandlers } from './worktreeFiles';

/** `fail`: the ref update after that many more throws, as a failed `update-ref` would. */
const refs = vi.hoisted(() => ({ fail: -1 }));
vi.mock('../engine/write/refs', async (load) => {
  const real = await load<typeof import('../engine/write/refs')>();
  return {
    ...real,
    casRefs: (...args: Parameters<typeof real.casRefs>) => {
      if (refs.fail >= 0 && refs.fail-- === 0) throw real.refMoved(args[1][0]?.name ?? 'HEAD');
      return real.casRefs(...args);
    },
  };
});

const NO = { head: null, refs: {} };

async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  await t.write('b.txt', 'b\n');
  const base = await t.commit('Base');
  return { t, base, ctx: fakeCtx(t.repo), wt: mainWt(t.repo) };
}
const status = async (t: Awaited<ReturnType<typeof repo>>['t']) => (await statusEntries(t.repo, t.dir)).map((e) => `${e.index}${e.worktree} ${e.path}`);
const top = (ctx: ReturnType<typeof fakeCtx>, dir: string) => ctx.writes.journal(dir).undoTop()!.id;
const undo = (ctx: ReturnType<typeof fakeCtx>, dir: string, o: { confirm?: Record<string, string | null>; confirmAutostash?: boolean } = {}) =>
  undoHandlers.undo({ repo: 1, worktree: dir, entry: top(ctx, dir), ...o }, ctx);
const redo = (ctx: ReturnType<typeof fakeCtx>, dir: string) => undoHandlers.redo({ repo: 1, worktree: dir, entry: ctx.writes.journal(dir).redoTop()!.id }, ctx);

describe('undo and redo', () => {
  it('a commit: undo moves the branch back with the changes staged, redo moves it forward', async () => {
    const { t, base, ctx, wt } = await repo();
    await t.write('a.txt', 'a2\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const c = (await commitHandlers.commit({ repo: 1, worktree: t.dir, summary: 'Two', description: '', amend: false, stageAll: false, expect: NO }, ctx)).outcome.oid;
    const u = await undo(ctx, t.dir);
    expect([u.outcome, readHead(wt).oid, await status(t), u.journal.redo?.label, u.journal.undo]).toEqual([{ status: 'done', label: 'commit "Two"' }, base, ['M. a.txt'], 'commit "Two"', null]);
    const r = await redo(ctx, t.dir);
    expect([r.outcome, readHead(wt).oid, await status(t)]).toEqual([{ status: 'done', label: 'commit "Two"' }, c, []]);
  });

  it('Stage all & commit: undo brings back the split from before', async () => {
    const { t, ctx } = await repo();
    await t.write('a.txt', 'a2\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    await t.write('b.txt', 'b2\n');
    await commitHandlers.commit({ repo: 1, worktree: t.dir, summary: 'All', description: '', amend: false, stageAll: true, expect: NO }, ctx);
    await undo(ctx, t.dir);
    expect(await status(t)).toEqual(['M. a.txt', '.M b.txt']);
    await redo(ctx, t.dir);
    expect(await status(t)).toEqual([]);
  });

  it('a discard round-trips through its snapshots', async () => {
    const { t, ctx } = await repo();
    await t.write('a.txt', 'mine\n');
    await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'paths', paths: ['a.txt'] } }, ctx);
    await undo(ctx, t.dir);
    expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe('mine\n');
    await redo(ctx, t.dir);
    expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe('a\n');
  });

  it('a checkout switches back, and a branch it created goes with its config', async () => {
    const { t, base, ctx, wt } = await repo();
    t.memfs.writeFileSync(`${t.repo.gitdir}/config`, `${t.memfs.readFileSync(`${t.repo.gitdir}/config`, 'utf8') as string}[remote "origin"]\n\turl = /demo/.origins/test.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    t.memfs.mkdirpSync(`${t.repo.gitdir}/refs/remotes/origin`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/refs/remotes/origin/topic`, `${base}\n`);
    await checkoutHandlers.checkout({ repo: 1, worktree: t.dir, target: { kind: 'remote', remote: 'origin', branch: 'topic' }, expect: NO }, ctx);
    await undo(ctx, t.dir);
    expect([readHead(wt).branch, t.repo.demo!.resolveRef(t.repo.demo!.refMap(), 'refs/heads/topic'), branchConfig(t.repo.demo!, 'topic').size]).toEqual(['main', null, 0]);
    await redo(ctx, t.dir);
    expect([readHead(wt).branch, branchConfig(t.repo.demo!, 'topic').get('branch.topic.remote')]).toEqual(['topic', ['origin']]);
  });

  it('asks when a ref moved since, then undoes anyway at the value it showed', async () => {
    const { t, base, ctx } = await repo();
    await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'topic', start: base, checkout: false, expect: NO }, ctx);
    await t.write('a.txt', 'moved\n');
    await t.checkout('topic');
    const moved = await t.commit('Moved topic');
    await t.checkout('main');
    const asked = await undo(ctx, t.dir);
    expect(asked.outcome).toEqual({ status: 'moved', label: 'create branch topic', refs: [{ name: 'refs/heads/topic', expected: base, actual: moved, target: null, dropped: 1, stays: false }] });
    const done = await undo(ctx, t.dir, { confirm: { 'refs/heads/topic': moved } });
    expect([done.outcome, t.repo.demo!.resolveRef(t.repo.demo!.refMap(), 'refs/heads/topic')]).toEqual([{ status: 'done', label: 'create branch topic' }, null]);
  });

  it('rewinds a merge, and refuses mid-merge and a stale entry', async () => {
    const { t, base, ctx, wt } = await repo();
    await t.branch('feature', base);
    await t.checkout('feature');
    await t.write('b.txt', 'feature\n');
    await t.commit('Feature');
    await t.checkout('main');
    await t.write('a.txt', 'main\n');
    const main = await t.commit('Main');
    await mergeHandlers.integrate({ repo: 1, worktree: t.dir, kind: 'merge', target: 'feature', expect: NO, confirm: { autostash: false } }, ctx);
    await expect(undoHandlers.undo({ repo: 1, worktree: t.dir, entry: 999 }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'The undo history changed; refreshed' });
    await undo(ctx, t.dir);
    expect([readHead(wt).oid, t.memfs.readFileSync(`${t.dir}/b.txt`, 'utf8')]).toEqual([main, 'b\n']);
  });

  it('undoes an older entry out of order when nothing later depends on it', async () => {
    const { t, base, ctx } = await repo();
    await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'one', start: base, checkout: false, expect: NO }, ctx);
    const one = top(ctx, t.dir);
    await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'two', start: base, checkout: false, expect: NO }, ctx);
    const r = await undoHandlers.undoEntry({ repo: 1, worktree: t.dir, entry: one }, ctx);
    const demo = t.repo.demo!;
    expect([r.outcome, demo.resolveRef(demo.refMap(), 'refs/heads/one'), demo.resolveRef(demo.refMap(), 'refs/heads/two'), ctx.writes.journal(t.dir).undo.map((e) => e.label)]).toEqual([{ status: 'done', label: 'create branch one' }, null, base, ['undo create branch one', 'create branch two']]);
    await t.write('a.txt', 'x\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    await commitHandlers.commit({ repo: 1, worktree: t.dir, summary: 'C1', description: '', amend: false, stageAll: false, expect: NO }, ctx);
    const c1 = top(ctx, t.dir);
    await commitHandlers.editHeadMessage({ repo: 1, worktree: t.dir, message: 'C1 reworded', expect: NO }, ctx);
    await expect(undoHandlers.undoEntry({ repo: 1, worktree: t.dir, entry: c1 }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'A later action moved main' });
  });
});

describe('every journaled kind undoes and redoes', () => {
  const ref = (t: Awaited<ReturnType<typeof repo>>['t'], name: string) => t.repo.demo!.resolveRef(t.repo.demo!.refMap(), name);
  const read = (t: Awaited<ReturnType<typeof repo>>['t'], p: string) => (t.memfs.existsSync(`${t.dir}/${p}`) ? (t.memfs.readFileSync(`${t.dir}/${p}`, 'utf8') as string) : null);

  it('an amend and a reworded message move the branch back and forward', async () => {
    const { t, base, ctx, wt } = await repo();
    await t.write('a.txt', 'a2\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const amended = (await commitHandlers.commit({ repo: 1, worktree: t.dir, summary: 'Base again', description: '', amend: true, stageAll: false, expect: NO }, ctx)).outcome.oid;
    await undo(ctx, t.dir);
    expect([readHead(wt).oid, await status(t)]).toEqual([base, ['M. a.txt']]);
    await redo(ctx, t.dir);
    expect([readHead(wt).oid, await status(t)]).toEqual([amended, []]);
  });

  it('a detached commit moves HEAD itself, and refuses once HEAD is on a branch', async () => {
    const { t, base, ctx, wt } = await repo();
    setHead(wt, { oid: base });
    await t.write('a.txt', 'a2\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const c = (await commitHandlers.commit({ repo: 1, worktree: t.dir, summary: 'Detached', description: '', amend: false, stageAll: false, expect: NO }, ctx)).outcome.oid;
    expect(ctx.writes.journal(t.dir).undoTop()?.undo).toBe('moveHead');
    await undo(ctx, t.dir);
    expect(readHead(wt)).toEqual({ branch: null, oid: base });
    await redo(ctx, t.dir);
    expect(readHead(wt)).toEqual({ branch: null, oid: c });
    setHead(wt, { branch: 'main' });
    await expect(undo(ctx, t.dir)).rejects.toMatchObject({ kind: 'InvalidInput', message: `HEAD is on main now: switch back to ${c.slice(0, 7)} to undo commit "Detached"` });
  });

  it('a rename goes back and again, with its config, and refuses once a name is reused', async () => {
    const { t, base, ctx } = await repo();
    await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'topic', start: base, checkout: false, expect: NO }, ctx);
    t.memfs.writeFileSync(`${t.repo.gitdir}/config`, `${t.memfs.readFileSync(`${t.repo.gitdir}/config`, 'utf8') as string}[branch "topic"]\n\tremote = .\n\tmerge = refs/heads/main\n`);
    await branchHandlers.renameBranch({ repo: 1, worktree: t.dir, from: 'topic', to: 'renamed', expect: NO }, ctx);
    const u = await undo(ctx, t.dir);
    expect([u.outcome, ref(t, 'refs/heads/topic'), ref(t, 'refs/heads/renamed'), branchConfig(t.repo.demo!, 'topic').get('branch.topic.merge')]).toEqual([{ status: 'done', label: 'rename branch topic to renamed' }, base, null, ['refs/heads/main']]);
    await redo(ctx, t.dir);
    expect([ref(t, 'refs/heads/topic'), ref(t, 'refs/heads/renamed'), branchConfig(t.repo.demo!, 'renamed').size, branchConfig(t.repo.demo!, 'topic').size]).toEqual([null, base, 2, 0]);
    await t.branch('topic', base);
    await expect(undo(ctx, t.dir)).rejects.toMatchObject({ kind: 'Stale', message: "rename branch topic to renamed can't be undone: topic has changed since" });
  });

  it('a deleted branch comes back with its config, and tags come and go', async () => {
    const { t, base, ctx } = await repo();
    await t.branch('gone', base);
    t.memfs.writeFileSync(`${t.repo.gitdir}/config`, `${t.memfs.readFileSync(`${t.repo.gitdir}/config`, 'utf8') as string}[branch "gone"]\n\tremote = .\n\tmerge = refs/heads/main\n`);
    await branchHandlers.deleteBranch({ repo: 1, worktree: t.dir, branch: 'gone', local: true, remote: null, force: false, expect: NO }, ctx);
    await undo(ctx, t.dir);
    expect([ref(t, 'refs/heads/gone'), branchConfig(t.repo.demo!, 'gone').get('branch.gone.remote')]).toEqual([base, ['.']]);
    await redo(ctx, t.dir);
    expect([ref(t, 'refs/heads/gone'), branchConfig(t.repo.demo!, 'gone').size]).toEqual([null, 0]);
    await branchHandlers.createTag({ repo: 1, worktree: t.dir, name: 'v1', target: base, message: 'One' }, ctx);
    const tag = ref(t, 'refs/tags/v1');
    await undo(ctx, t.dir);
    expect(ref(t, 'refs/tags/v1')).toBeNull();
    await redo(ctx, t.dir);
    expect(ref(t, 'refs/tags/v1')).toBe(tag);
    await branchHandlers.deleteTag({ repo: 1, worktree: t.dir, name: 'v1', local: true }, ctx);
    await undo(ctx, t.dir);
    expect(ref(t, 'refs/tags/v1')).toBe(tag);
  });

  it('a merge redoes forward, and nothing undoes while a merge is stopped', async () => {
    const { t, base, ctx, wt } = await repo();
    await t.branch('feature', base);
    await t.checkout('feature');
    await t.write('b.txt', 'feature\n');
    await t.write('a.txt', 'feature\n');
    await t.commit('Feature');
    await t.checkout('main');
    await t.write('a.txt', 'main\n');
    const main = await t.commit('Main');
    await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'mark', start: base, checkout: false, expect: NO }, ctx);
    const r = await mergeHandlers.integrate({ repo: 1, worktree: t.dir, kind: 'merge', target: 'feature', expect: NO, confirm: { autostash: false } }, ctx);
    expect(r.outcome).toMatchObject({ status: 'stopped' });
    await expect(undo(ctx, t.dir)).rejects.toMatchObject({ kind: 'InProgress', message: 'A merge is in progress' });
    await t.write('a.txt', 'resolved\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const merged = (await commitHandlers.commit({ repo: 1, worktree: t.dir, summary: 'Merge', description: '', amend: false, stageAll: false, expect: NO }, ctx)).outcome.oid;
    expect(ctx.writes.journal(t.dir).undoTop()?.undo).toBe('rewind');
    await undo(ctx, t.dir);
    expect([readHead(wt).oid, read(t, 'a.txt'), read(t, 'b.txt'), await status(t)]).toEqual([main, 'main\n', 'b\n', []]);
    await redo(ctx, t.dir);
    expect([readHead(wt).oid, read(t, 'a.txt'), read(t, 'b.txt'), await status(t)]).toEqual([merged, 'resolved\n', 'feature\n', []]);
  });

  it('a stash push, pop and drop undo and redo', async () => {
    const { t, ctx } = await repo();
    await t.write('a.txt', 'mine\n');
    await stashHandlers.stashPush({ repo: 1, worktree: t.dir, message: 'Keep' }, ctx);
    expect([read(t, 'a.txt'), t.repo.demo!.stashes().length]).toEqual(['a\n', 1]);
    await undo(ctx, t.dir);
    expect([read(t, 'a.txt'), t.repo.demo!.stashes().length]).toEqual(['mine\n', 0]);
    await redo(ctx, t.dir);
    const oid = t.repo.demo!.stashes()[0].id;
    expect(read(t, 'a.txt')).toBe('a\n');
    await stashHandlers.stashApply({ repo: 1, worktree: t.dir, oid, pop: true }, ctx);
    expect([read(t, 'a.txt'), t.repo.demo!.stashes().length]).toEqual(['mine\n', 0]);
    await undo(ctx, t.dir);
    expect([read(t, 'a.txt'), t.repo.demo!.stashes().map((s) => s.id)]).toEqual(['a\n', [oid]]);
    await redo(ctx, t.dir);
    expect([read(t, 'a.txt'), t.repo.demo!.stashes().length]).toEqual(['mine\n', 0]);
    await stashHandlers.stashPush({ repo: 1, worktree: t.dir, message: 'Again' }, ctx);
    const again = t.repo.demo!.stashes()[0].id;
    await stashHandlers.stashDrop({ repo: 1, worktree: t.dir, oid: again }, ctx);
    await undo(ctx, t.dir);
    expect(t.repo.demo!.stashes().map((s) => s.id)).toEqual([again]);
    await redo(ctx, t.dir);
    expect(t.repo.demo!.stashes()).toEqual([]);
  });

  it('soft, mixed and hard resets undo and redo', async () => {
    const { t, base, ctx, wt } = await repo();
    await t.write('a.txt', 'a2\n');
    const two = await t.commit('Two');
    await t.write('b.txt', 'mine\n');
    for (const mode of ['soft', 'mixed', 'hard'] as const) {
      await resetHandlers.reset({ repo: 1, worktree: t.dir, to: base, mode, expect: NO, discard: true }, ctx);
      const after = [readHead(wt).oid, read(t, 'a.txt'), read(t, 'b.txt'), await status(t)];
      await undo(ctx, t.dir);
      expect([mode, readHead(wt).oid, read(t, 'a.txt'), read(t, 'b.txt'), await status(t)]).toEqual([mode, two, 'a2\n', 'mine\n', ['.M b.txt']]);
      await redo(ctx, t.dir);
      expect([mode, readHead(wt).oid, read(t, 'a.txt'), read(t, 'b.txt'), await status(t)]).toEqual([mode, ...after]);
      await undo(ctx, t.dir);
    }
  });

  it("a hard reset's undo over a folder in a file's place asks first, changing nothing", async () => {
    const { t, base, ctx, wt } = await repo();
    await t.write('a.txt', 'a2\n');
    await t.commit('Two');
    await t.write('b.txt', 'mine\n');
    await resetHandlers.reset({ repo: 1, worktree: t.dir, to: base, mode: 'hard', expect: NO, discard: true }, ctx);
    const id = top(ctx, t.dir);
    t.memfs.unlinkSync(`${t.dir}/b.txt`);
    await t.write('b.txt/inside.txt', 'x\n');
    const before = await status(t);
    await expect(undo(ctx, t.dir)).rejects.toMatchObject({ kind: 'Conflict', message: `Your changes conflict with undo reset main to ${base.slice(0, 7)} (hard)` });
    expect([readHead(wt).oid, read(t, 'a.txt'), await status(t), top(ctx, t.dir), t.repo.demo!.stashes()]).toEqual([base, 'a\n', before, id, []]);
  });

  it('saves, a new file and a file restored from a commit round-trip through their snapshots', async () => {
    const { t, base, ctx } = await repo();
    await t.write('a.txt', 'a2\n');
    await t.commit('Two');
    const h = worktreeFileHandlers;
    await h.writeWorktreeFile({ repo: 1, worktree: t.dir, path: 'b.txt', text: 'saved\n', base: await blobId(t.memfs.readFileSync(`${t.dir}/b.txt`) as Uint8Array) }, ctx);
    await undo(ctx, t.dir);
    expect(read(t, 'b.txt')).toBe('b\n');
    await redo(ctx, t.dir);
    expect(read(t, 'b.txt')).toBe('saved\n');
    await h.createWorktreeFile({ repo: 1, worktree: t.dir, path: 'new/c.txt' }, ctx);
    await undo(ctx, t.dir);
    expect([read(t, 'new/c.txt'), t.memfs.existsSync(`${t.dir}/new`)]).toEqual([null, false]);
    await redo(ctx, t.dir);
    expect(read(t, 'new/c.txt')).toBe('');
    await h.restoreFile({ repo: 1, worktree: t.dir, sha: base, path: 'a.txt' }, ctx);
    expect(read(t, 'a.txt')).toBe('a\n');
    await undo(ctx, t.dir);
    expect(read(t, 'a.txt')).toBe('a2\n');
    await redo(ctx, t.dir);
    expect(read(t, 'a.txt')).toBe('a\n');
  });

  it('a switch asks when HEAD moved since, then switches back from where it is', async () => {
    const { t, base, ctx, wt } = await repo();
    await t.branch('topic', base);
    await t.branch('other', base);
    await checkoutHandlers.checkout({ repo: 1, worktree: t.dir, target: { kind: 'branch', name: 'topic' }, expect: NO }, ctx);
    setHead(wt, { branch: 'other' });
    const asked = await undo(ctx, t.dir);
    expect(asked.outcome).toEqual({ status: 'moved', label: 'checkout topic', refs: [{ name: 'HEAD', expected: 'refs/heads/topic', actual: 'refs/heads/other', target: 'refs/heads/main', dropped: 0, stays: false }] });
    await undo(ctx, t.dir, { confirm: { HEAD: 'refs/heads/other' } });
    expect(readHead(wt).branch).toBe('main');
    await redo(ctx, t.dir);
    expect(readHead(wt).branch).toBe('topic');
  });

  it('a discard undone out of order takes its place, can itself be undone, and Redo stays', async () => {
    const { t, ctx } = await repo();
    await t.write('a.txt', 'mine\n');
    await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'paths', paths: ['a.txt'] } }, ctx);
    const discard = top(ctx, t.dir);
    await t.write('b.txt', 'other\n');
    await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'paths', paths: ['b.txt'] } }, ctx);
    await t.write('b.txt', 'third\n');
    await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'paths', paths: ['b.txt'] } }, ctx);
    await undo(ctx, t.dir);
    expect(read(t, 'b.txt')).toBe('third\n');
    await t.write('b.txt', 'b\n');
    const r = await undoHandlers.undoEntry({ repo: 1, worktree: t.dir, entry: discard, confirmAutostash: false }, ctx);
    const j = ctx.writes.journal(t.dir);
    expect([r.outcome, read(t, 'a.txt'), j.undo.map((e) => e.label), j.redo.map((e) => e.label)]).toEqual([{ status: 'done', label: 'discard a.txt' }, 'mine\n', ['undo discard a.txt', 'discard b.txt'], ['discard b.txt']]);
    await undoHandlers.undoEntry({ repo: 1, worktree: t.dir, entry: j.undo[0].id, confirmAutostash: false }, ctx);
    expect([read(t, 'a.txt'), j.undo.map((e) => e.label)]).toEqual(['a\n', ['undo undo discard a.txt', 'discard b.txt']]);
    await t.write('a.txt', 'edited since\n');
    await expect(undoHandlers.undoEntry({ repo: 1, worktree: t.dir, entry: j.undo[0].id, confirmAutostash: false }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: "a.txt changed since undo undo discard a.txt; it can't be undone out of order" });
  });

  it('an out-of-order undo clears Redo when the redo entry depends on it, else keeps it', async () => {
    const { t, base, ctx } = await repo();
    await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'one', start: base, checkout: false, expect: NO }, ctx);
    const one = top(ctx, t.dir);
    await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'two', start: base, checkout: false, expect: NO }, ctx);
    await branchHandlers.deleteBranch({ repo: 1, worktree: t.dir, branch: 'one', local: true, remote: null, force: false, expect: NO }, ctx);
    await undo(ctx, t.dir);
    expect(ctx.writes.journal(t.dir).redo.map((e) => e.label)).toEqual(['delete branch one']);
    const r = await undoHandlers.undoEntry({ repo: 1, worktree: t.dir, entry: one, confirmAutostash: false }, ctx);
    expect([r.journal.redo, r.journal.undo?.label, ref(t, 'refs/heads/one')]).toEqual([null, 'create branch two', null]);
  });

  it('an out-of-order undo refuses a ref moved since, HEAD changing its paths, and a branch checked out', async () => {
    const { t, base, ctx, wt } = await repo();
    const later = async (name: string) => branchHandlers.createBranch({ repo: 1, worktree: t.dir, name, start: base, checkout: false, expect: NO }, ctx);
    await later('one');
    const one = top(ctx, t.dir);
    await later('two');
    const outOfOrder = (entry: number) => undoHandlers.undoEntry({ repo: 1, worktree: t.dir, entry, confirmAutostash: false }, ctx);
    await t.write('a.txt', 'moved\n');
    await t.checkout('one');
    await t.commit('Moved one');
    await t.checkout('main');
    await expect(outOfOrder(one)).rejects.toMatchObject({ kind: 'Stale', message: "one changed since create branch one; it can't be undone out of order" });
    t.repo.demo!.fs.writeFileSync(`${t.repo.gitdir}/refs/heads/one`, `${base}\n`);
    await addWorktree(t, 'side', 'one');
    await expect(outOfOrder(one)).rejects.toMatchObject({ kind: 'InvalidInput', message: `one is checked out in /demo/.extra/test/wt-side` });
    const g = await repo();
    await g.t.write('a.txt', 'mine\n');
    await discardHandlers.discard({ repo: 1, worktree: g.t.dir, scope: { kind: 'paths', paths: ['a.txt'] } }, g.ctx);
    const discard = top(g.ctx, g.t.dir);
    await g.t.write('b.txt', 'other\n');
    await discardHandlers.discard({ repo: 1, worktree: g.t.dir, scope: { kind: 'paths', paths: ['b.txt'] } }, g.ctx);
    await g.t.write('a.txt', 'committed\n');
    await g.t.commit('Outside');
    await expect(undoHandlers.undoEntry({ repo: 1, worktree: g.t.dir, entry: discard, confirmAutostash: false }, g.ctx)).rejects.toMatchObject({ kind: 'Stale', message: "HEAD changed a.txt since discard a.txt; it can't be undone out of order" });
    // Checked out here too: the main worktree is listed first.
    setHead(wt, { branch: 'one' });
    await expect(outOfOrder(one)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'one is checked out: switch away from it to undo create branch one' });
  });

  it("Stage all & commit's index is read back when the ref move then fails", async () => {
    const { t, ctx, wt } = await repo();
    await t.write('a.txt', 'a2\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    await t.write('b.txt', 'b2\n');
    const c = (await commitHandlers.commit({ repo: 1, worktree: t.dir, summary: 'All', description: '', amend: false, stageAll: true, expect: NO }, ctx)).outcome.oid;
    const id = top(ctx, t.dir);
    refs.fail = 0;
    await expect(undo(ctx, t.dir)).rejects.toMatchObject({ kind: 'RefMoved' });
    refs.fail = -1;
    expect([readHead(wt).oid, await status(t), top(ctx, t.dir)]).toEqual([c, [], id]);
    await undo(ctx, t.dir);
    expect(await status(t)).toEqual(['M. a.txt', '.M b.txt']);
  });
});

