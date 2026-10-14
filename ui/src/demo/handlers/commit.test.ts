import { describe, expect, it } from 'vitest';
import type { AppEvent } from '../../api/gen/AppEvent';
import { readCommit } from '../engine/read/commitText';
import { fakeCtx, makeTestRepo, addWorktree, setIndex } from '../engine/read/testkit';
import { MODE_FILE } from '../engine/read/trees';
import { loadIndex } from '../engine/write/index';
import { readHead, setHead } from '../engine/write/refs';
import { mainWt } from '../engine/write/seam';
import { statusEntries } from '../engine/write/status';
import { commitHandlers } from './commit';
import { stageHandlers } from './stage';
import { pushedDev } from '../engine/seq/fixtures';
import { rewrittenOf } from '../engine/seq/rewrites';
import { undoHandlers } from './undo';

const NO = { head: null, refs: {} };
const commit = (ctx: ReturnType<typeof fakeCtx>, dir: string, summary: string, o: { description?: string; amend?: boolean; stageAll?: boolean } = {}) =>
  commitHandlers.commit({ repo: 1, worktree: dir, summary, description: o.description ?? '', amend: o.amend ?? false, stageAll: o.stageAll ?? false, expect: NO }, ctx);

async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  const base = await t.commit('Base');
  const ctx = fakeCtx(t.repo);
  return { t, base, ctx, wt: mainWt(t.repo) };
}

describe('commit', () => {
  it('commits the index as the visitor, journals it, and the graph store has it', async () => {
    const { t, base, ctx } = await repo();
    await t.write('a.txt', 'a2\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const r = await commit(ctx, t.dir, '#123 fix the parser', { description: '# Why\n\nIt broke.\n\n\n# How  \nCarefully.' });
    const c = await readCommit(t.repo, r.outcome.oid);
    expect([c.parents, c.author.name, c.author.email, c.author.time, c.rawMessage]).toEqual([[base], 'You', 'you@example.com', 1_800_000_000, '#123 fix the parser\n\n# Why\n\nIt broke.\n\n# How\nCarefully.\n']);
    expect(readHead(mainWt(t.repo))).toEqual({ branch: 'main', oid: r.outcome.oid });
    expect(r.journal.undo).toMatchObject({ label: 'commit "#123 fix the parser"', kind: 'commit' });
    expect(ctx.writes.journal(t.dir).undoTop()?.undo).toBe('moveRefs');
    expect(t.repo.demo!.commits.has(r.outcome.oid)).toBe(true);
    expect(r.wip?.staged.files).toEqual([]);
  });

  it('stages everything for Stage all & commit, recording the split', async () => {
    const { t, ctx } = await repo();
    await t.write('a.txt', 'a2\n');
    await t.write('b.txt', 'b\n');
    const r = await commit(ctx, t.dir, 'All of it', { stageAll: true });
    expect(await statusEntries(t.repo, t.dir)).toEqual([]);
    expect(ctx.writes.journal(t.dir).entry(r.journal.undo!.entry)?.indexBefore).toMatch(/^[0-9a-f]{40}$/);
  });

  it('amends with the same parents and author, and edits the HEAD message alone', async () => {
    const { t, base, ctx } = await repo();
    const recorded: [string | null, string[]][] = [];
    ctx.writes.recordRewrite = async (_repo, kind, moves) => void recorded.push([kind, moves.map((m) => m.name)]);
    await t.write('a.txt', 'a2\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const first = (await commit(ctx, t.dir, 'two')).outcome.oid;
    await t.write('a.txt', 'a3\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const amended = (await commit(ctx, t.dir, 'two, amended', { amend: true })).outcome.oid;
    const c = await readCommit(t.repo, amended);
    expect([c.parents, c.summary]).toEqual([[base], 'two, amended']);
    expect(amended).not.toBe(first);
    await t.write('a.txt', 'a4\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const r = await commitHandlers.editHeadMessage({ repo: 1, worktree: t.dir, message: 'two, reworded\n\nwith a body', expect: { head: amended, refs: {} } }, ctx);
    const e = await readCommit(t.repo, r.outcome.oid);
    expect([e.tree, e.parents, e.message, r.journal.undo?.label]).toEqual([c.tree, [base], 'two, reworded\n\nwith a body', 'amend "two, reworded"']);
    expect(r.wip?.staged.files.map((f) => f.path)).toEqual(['a.txt']);
    // Every write tells the rewrite marks what moved; an amend says it rewrote.
    const main = ['refs/heads/main'];
    expect(recorded).toEqual([[null, []], [null, main], [null, []], ['amend', main], [null, []], ['amend', main]]);
  });

  describe('rewrite marks', () => {
    const mine = async () => {
      const t = await makeTestRepo();
      await pushedDev(t);
      return { t, ctx: fakeCtx(t.repo) };
    };
    const stageChange = async (t: Awaited<ReturnType<typeof mine>>['t'], ctx: ReturnType<typeof fakeCtx>) => {
      await t.write('d2.txt', 'd2, changed\n');
      await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['d2.txt'] }, ctx);
    };

    it('an amend of a pushed branch marks it, and Undo drops the mark', async () => {
      const { t, ctx } = await mine();
      await stageChange(t, ctx);
      await commit(ctx, t.dir, 'D2, amended', { amend: true });
      expect(await rewrittenOf(t.repo, 'dev')).toEqual({ kind: 'amend', remote: 'origin' });
      await undoHandlers.undo({ repo: 1, worktree: t.dir, entry: ctx.writes.journal(t.dir).undoTop()!.id }, ctx);
      expect(await rewrittenOf(t.repo, 'dev')).toBeNull();
    });

    it('editHeadMessage of a pushed branch marks it', async () => {
      const { t, ctx } = await mine();
      await commitHandlers.editHeadMessage({ repo: 1, worktree: t.dir, message: 'D2, reworded', expect: { head: await t.rev('dev'), refs: {} } }, ctx);
      expect(await rewrittenOf(t.repo, 'dev')).toEqual({ kind: 'amend', remote: 'origin' });
    });
  });

  it('refuses what git would, before anything is written', async () => {
    const { t, ctx } = await repo();
    await expect(commit(ctx, t.dir, '   ')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Write a commit summary' });
    await expect(commit(ctx, t.dir, 'x')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Nothing to commit' });
    await expect(commit(ctx, t.dir, 'x', { stageAll: true })).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Nothing to commit' });
    await expect(commit(ctx, t.dir, 'x', { amend: true, stageAll: true })).rejects.toMatchObject({ kind: 'InvalidInput', message: "Amend doesn't stage everything" });
    const blob = (await loadIndex(mainWt(t.repo)))[0].oid;
    await setIndex(t, [{ path: 'a.txt', mode: MODE_FILE, oid: blob, stage: 2 }, { path: 'a.txt', mode: MODE_FILE, oid: blob, stage: 3 }]);
    await expect(commit(ctx, t.dir, 'x')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Resolve 1 conflicted file first' });
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
  });

  it('commits on a detached HEAD as MoveHead, and makes a merge commit in a merge', async () => {
    const { t, base, ctx } = await repo();
    const wt = mainWt(t.repo);
    setHead(wt, { oid: base });
    await t.write('a.txt', 'a2\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const d = (await commit(ctx, t.dir, 'Detached')).outcome.oid;
    expect([readHead(wt), ctx.writes.journal(t.dir).undoTop()?.undo]).toEqual([{ branch: null, oid: d }, 'moveHead']);
    await t.write('a.txt', 'a3\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const d2 = (await commit(ctx, t.dir, 'Detached again')).outcome.oid;
    setHead(wt, { branch: 'main' });
    // An octopus merge lists every head it merges.
    t.memfs.writeFileSync(`${t.repo.gitdir}/MERGE_HEAD`, `${d}\n${d2}\n`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/MERGE_MSG`, "Merge commit 'd'\n");
    t.memfs.writeFileSync(`${t.repo.gitdir}/SQUASH_MSG`, 'Squashed\n');
    const events: AppEvent[] = [];
    const m = (await commit({ ...ctx, emit: (ev: AppEvent) => void events.push(ev) }, t.dir, "Merge commit 'd'")).outcome.oid;
    // As the core's commit.rs: the merge state's end is no State change of its own.
    expect(events.find((e) => e.type === 'repoChanged')).toMatchObject({ kinds: ['worktree', 'index', 'refs', 'head'] });
    expect((await readCommit(t.repo, m)).parents).toEqual([base, d, d2]);
    expect(['MERGE_HEAD', 'MERGE_MSG', 'SQUASH_MSG'].map((f) => t.memfs.existsSync(`${t.repo.gitdir}/${f}`))).toEqual([false, false, false]);
  });

  it('a commit in a linked worktree commits only its index and journals there (Review Focus 1)', async () => {
    const { t, base, ctx } = await repo();
    await t.branch('feature', base);
    const side = await addWorktree(t, 'side', 'feature');
    t.memfs.writeFileSync(`${side}/s.txt`, 'side\n');
    await t.write('a.txt', "main's staged change\n");
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    await stageHandlers.stage({ repo: 1, worktree: side, paths: ['s.txt'] }, ctx);
    const r = await commit(ctx, side, 'Side work');
    expect(await t.rev('feature')).toBe(r.outcome.oid);
    expect(await t.rev('main')).toBe(base);
    expect((await statusEntries(t.repo, t.dir)).map((e) => e.path)).toEqual(['a.txt']);
    expect([ctx.writes.journal(t.dir).undoTop(), ctx.writes.journal(side).undoTop()?.label]).toEqual([null, 'commit "Side work"']);
  });

  it('says whether HEAD is on its upstream, and who commits', async () => {
    const { t, base, ctx } = await repo();
    const demo = t.repo.demo!;
    const { setConfigValues } = await import('../engine/write/config');
    setConfigValues(demo, 'branch.main.remote', ['origin']);
    setConfigValues(demo, 'branch.main.merge', ['refs/heads/main']);
    t.memfs.writeFileSync(`${demo.gitdir}/config`, `${t.memfs.readFileSync(`${demo.gitdir}/config`, 'utf8') as string}[remote "origin"]\n\turl = /demo/.origins/test.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    t.memfs.mkdirpSync(`${demo.gitdir}/refs/remotes/origin`);
    t.memfs.writeFileSync(`${demo.gitdir}/refs/remotes/origin/main`, `${base}\n`);
    expect(await commitHandlers.headOnUpstream({ repo: 1, worktree: t.dir }, ctx)).toBe('origin/main');
    await t.write('a.txt', 'local only\n');
    await commit(ctx, t.dir, 'local only', { stageAll: true });
    expect(await commitHandlers.headOnUpstream({ repo: 1, worktree: t.dir }, ctx)).toBeNull();
    expect(await commitHandlers.commitIdentity({ repo: 1, worktree: t.dir }, ctx)).toEqual({ name: 'You', email: 'you@example.com' });
  });
});
