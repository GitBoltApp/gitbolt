import { describe, expect, it } from 'vitest';
import { readCommit } from '../read/commitText';
import { makeTestRepo, type TestRepo } from '../read/testkit';
import { NO_EXPECT, readInProgress } from '../writeSeam';
import { openForWrite } from '../writeSeamTest';
import { pickHandlers } from '../../handlers/pick';
import { undoHandlers } from '../../handlers/undo';
import { subjects } from './fixtures';

/** main: `one`; feature adds f1, f2, f3 in three commits. HEAD: main. Oids oldest first (the core's three_on_feature). */
async function threeOnFeature(): Promise<{ t: TestRepo; oids: string[] }> {
  const t = await makeTestRepo();
  await t.write('one.txt', 'one\n');
  await t.commit('one');
  await t.branch('feature');
  await t.checkout('feature');
  const oids: string[] = [];
  for (const f of ['f1', 'f2', 'f3']) {
    await t.write(`${f}.txt`, `${f}\n`);
    oids.push(await t.commit(`Add ${f}`));
  }
  await t.checkout('main');
  return { t, oids };
}
const newestFirst = (o: string[]) => [...o].reverse();
const confirm = { autostash: false };

/** main edits a.txt; side edits it too, then adds b.txt. HEAD: main. */
async function conflictingSide(): Promise<{ t: TestRepo; main: string; s1: string; s2: string }> {
  const t = await makeTestRepo();
  await t.write('a.txt', 'base\n');
  await t.commit('Base');
  await t.branch('side');
  await t.write('a.txt', 'main\n');
  const main = await t.commit('Main');
  await t.checkout('side');
  await t.write('a.txt', 'side\n');
  const s1 = await t.commit('Side edits a');
  await t.write('b.txt', 'b\n');
  const s2 = await t.commit('Side adds b');
  await t.checkout('main');
  return { t, main, s1, s2 };
}

describe('cherry-pick and revert', () => {
  it('picks oldest first, keeping each author, and says how many', async () => {
    const { t, oids } = await threeOnFeature();
    const { ctx, id, wt } = await openForWrite(t);
    const r = await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: newestFirst(oids), expect: NO_EXPECT, confirm }, ctx);
    expect(r.outcome).toEqual({ status: 'done', commits: 3, committed: true });
    expect(await subjects(t, 'main~3', 'main')).toEqual(['Add f1', 'Add f2', 'Add f3']);
    expect(r.journal.undo?.label).toBe('cherry-pick 3 commits onto main');
    expect((await readCommit(t.repo, await t.rev('main'))).author.name).toBe((await readCommit(t.repo, oids[2])).author.name);
  });

  it('reverts newest first, as the visitor', async () => {
    const { t, oids } = await threeOnFeature();
    await t.checkout('feature');
    const { ctx, id, wt } = await openForWrite(t);
    const r = await pickHandlers.revert({ repo: id, worktree: wt, oids: newestFirst(oids).slice(0, 2), expect: NO_EXPECT, confirm }, ctx);
    expect(r.outcome).toEqual({ status: 'done', commits: 2, committed: true });
    const tip = await readCommit(t.repo, await t.rev('feature'));
    expect(tip.summary).toBe('Revert "Add f2"');
    expect(tip.author.name).toBe('You');
    expect(r.journal.undo?.label).toBe('revert 2 commits');
  });

  it('refuses merges, unknown commits, a detached HEAD and nothing', async () => {
    const { t, oids } = await threeOnFeature();
    const { ctx, id, wt } = await openForWrite(t);
    await expect(pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [], expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({ message: 'Nothing to cherry-pick' });
    await expect(pickHandlers.revert({ repo: id, worktree: wt, oids: [], expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({ message: 'Nothing to revert' });
    const m = await t.commit('Merge', undefined, { parents: [await t.rev('main'), oids[2]] });
    await expect(pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [m], expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({ message: `${m.slice(0, 7)} is a merge commit: GitVolt doesn't cherry-pick or revert merges` });
    await expect(pickHandlers.cherryPick({ repo: id, worktree: wt, oids: ['a'.repeat(40)], expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({ kind: 'NotFound' });
    await expect(pickHandlers.cherryPick({ repo: id, worktree: wt, oids: ['nope'], expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({ message: 'not an object id: nope' });
    await t.checkout(await t.rev('main'));
    await expect(pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [oids[0]], expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({ message: 'Check out a branch to cherry-pick onto it' });
    await expect(pickHandlers.revert({ repo: id, worktree: wt, oids: [oids[0]], expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({ message: 'Check out a branch to make the revert on' });
  });

  it('a conflict pauses; Continue commits the resolution and goes on; Abort puts the branch back', async () => {
    const { t, main, s1, s2 } = await conflictingSide();
    const { ctx, id, wt } = await openForWrite(t);
    const r = await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [s2, s1], expect: NO_EXPECT, confirm }, ctx);
    expect(r.outcome).toEqual({ status: 'stopped', files: 1, at: s1, applied: 0, committed: true });
    expect(r.journal.paused).toMatchObject({ kind: 'cherryPick', target: '2 commits' });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ kind: 'cherryPick', head: s1, conflicted: 1 });
    // Continue is refused while a file is conflicted, in the core's words.
    await expect(pickHandlers.pickControl({ repo: id, worktree: wt, action: 'continue' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Resolve 1 conflicted file first' });
    await t.write('a.txt', 'both\n');
    await t.stage('a.txt');
    const c = await pickHandlers.pickControl({ repo: id, worktree: wt, action: 'continue' }, ctx);
    expect(c.outcome).toEqual({ status: 'done' });
    expect(await subjects(t, main, 'main')).toEqual(['Side edits a', 'Side adds b']);
    expect(c.journal.paused).toBeNull();

    const again = await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [s1], expect: NO_EXPECT, confirm }, ctx);
    expect(again.outcome).toMatchObject({ status: 'stopped' });
    const tip = await t.rev('main');
    const a = await pickHandlers.pickControl({ repo: id, worktree: wt, action: 'abort' }, ctx);
    expect(a.outcome).toEqual({ status: 'aborted' });
    expect(await t.rev('main')).toBe(tip);
    expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
  });

  it("a stop and its Abort mark what the core's git runs change (sequence.rs, pick.rs)", async () => {
    const { t, s1 } = await conflictingSide();
    const { ctx, id, wt } = await openForWrite(t);
    const kinds = () => ctx.events.filter((e) => e.type === 'repoChanged').at(-1);
    await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [s1], expect: NO_EXPECT, confirm }, ctx);
    expect(kinds()).toMatchObject({ kinds: ['worktree', 'index', 'refs', 'head', 'state'] });
    await pickHandlers.pickControl({ repo: id, worktree: wt, action: 'abort' }, ctx);
    expect(kinds()).toMatchObject({ kinds: ['worktree', 'index', 'head', 'state'] });
  });

  it('Skip drops the stopped commit and goes on to the next', async () => {
    const { t, main, s1, s2 } = await conflictingSide();
    const { ctx, id, wt } = await openForWrite(t);
    await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [s2, s1], expect: NO_EXPECT, confirm }, ctx);
    const r = await pickHandlers.pickControl({ repo: id, worktree: wt, action: 'skip' }, ctx);
    expect(r.outcome).toEqual({ status: 'done' });
    expect(await subjects(t, main, 'main')).toEqual(['Side adds b']);
  });

  it('a revert stopped on a conflict is a revert in progress', async () => {
    const { t, s1 } = await conflictingSide();
    // `main` edited a.txt too: reverting Side's edit (from a later state) conflicts.
    await t.checkout('side');
    const { ctx, id, wt } = await openForWrite(t);
    await t.write('a.txt', 'later\n');
    await t.commit('Later');
    const r = await pickHandlers.revert({ repo: id, worktree: wt, oids: [s1], expect: NO_EXPECT, confirm }, ctx);
    expect(r.outcome).toMatchObject({ status: 'stopped', at: s1, committed: true });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ kind: 'revert' });
    await expect(pickHandlers.pickControl({ repo: id, worktree: wt, action: 'abort' }, ctx)).resolves.toMatchObject({ outcome: { status: 'aborted' } });
  });

  it('an empty revert quits the sequence, keeps what went in and says how far it got', async () => {
    const t = await makeTestRepo();
    await t.write('f.txt', 'a\n');
    await t.commit('Base');
    await t.branch('side');
    await t.write('f.txt', 'b\n');
    const x = await t.commit('X sets b');
    await t.checkout('side');
    await t.write('f.txt', 'b\n');
    const y = await t.commit('Y sets b');
    await t.checkout('main');
    const { ctx, id, wt } = await openForWrite(t);
    const e = await pickHandlers.revert({ repo: id, worktree: wt, oids: [x, y], expect: NO_EXPECT, confirm }, ctx).catch((err) => err);
    expect(e.message).toBe("git exited with status 1 (1 of 2 applied, the rest weren't)");
    expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
    expect(await subjects(t, x, 'main')).toEqual(['Revert "X sets b"']);
    // The commit that went in has its entry: Undo takes it back.
    expect(ctx.writes.journal(wt).undoTop()?.label).toBe('revert 2 commits');
  });

  it('refuses a control with nothing to settle', async () => {
    const { t } = await threeOnFeature();
    const { ctx, id, wt } = await openForWrite(t);
    await expect(pickHandlers.pickControl({ repo: id, worktree: wt, action: 'abort' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'No cherry-pick or revert is in progress' });
  });

  it('an unrelated staged change is stashed for the picks and comes back', async () => {
    const { t, oids } = await threeOnFeature();
    await t.write('other.txt', 'x\n');
    await t.stage('other.txt');
    const { ctx, id, wt } = await openForWrite(t);
    const r = await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [oids[0]], expect: NO_EXPECT, confirm }, ctx);
    expect(r.outcome).toEqual({ status: 'done', commits: 1, committed: true });
    expect(r.wip?.staged.files.map((f) => f.path)).toEqual(['other.txt']);
  });

  it('a conflicted index left by a pick without committing blocks the next pick, in git\'s words', async () => {
    const { t, s1, s2 } = await conflictingSide();
    const { ctx, id, wt } = await openForWrite(t);
    await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [s1], noCommit: true, expect: NO_EXPECT, confirm }, ctx);
    await expect(pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [s2], noCommit: true, expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({ message: 'your index file is unmerged.' });
  });

  describe('without committing', () => {
    it('stages the changes and leaves nothing in progress', async () => {
      const { t, oids } = await threeOnFeature();
      const head = await t.rev('main');
      const { ctx, id, wt } = await openForWrite(t);
      const r = await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: newestFirst(oids), noCommit: true, expect: NO_EXPECT, confirm }, ctx);
      expect(r.outcome).toEqual({ status: 'done', commits: 3, committed: false });
      expect(await t.rev('main')).toBe(head);
      expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
      expect(r.wip?.staged.files.map((f) => f.path)).toEqual(['f1.txt', 'f2.txt', 'f3.txt']);
      expect(r.journal.undo?.label).toBe('cherry-pick 3 commits onto main without committing');
      // Its Undo puts the files back.
      const u = await undoHandlers.undo({ repo: id, worktree: wt, entry: r.journal.undo!.entry }, ctx);
      expect(u.outcome).toMatchObject({ status: 'done' });
      expect(u.wip?.staged.files).toEqual([]);
      expect(t.memfs.existsSync(`${t.dir}/f1.txt`, false)).toBe(false);
    });

    it("refuses the user's own changes to a path of the picks", async () => {
      const { t, oids } = await threeOnFeature();
      await t.write('f2.txt', 'mine\n');
      const { ctx, id, wt } = await openForWrite(t);
      await expect(pickHandlers.cherryPick({ repo: id, worktree: wt, oids: newestFirst(oids), noCommit: true, expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({
        kind: 'DirtyWorktree',
        message: 'Commit or stash your changes to f2.txt first: the cherry-pick changes it too',
      });
      await expect(pickHandlers.revert({ repo: id, worktree: wt, oids: [oids[1]], noCommit: true, expect: NO_EXPECT, confirm }, ctx)).rejects.toMatchObject({ message: 'Commit or stash your changes to f2.txt first: the revert changes it too' });
    });

    it('leaves the user\'s other staged changes alone', async () => {
      const { t, oids } = await threeOnFeature();
      await t.write('other.txt', 'x\n');
      await t.stage('other.txt');
      const { ctx, id, wt } = await openForWrite(t);
      const r = await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [oids[0]], noCommit: true, expect: NO_EXPECT, confirm }, ctx);
      expect(r.outcome).toEqual({ status: 'done', commits: 1, committed: false });
      expect(r.wip?.staged.files.map((f) => f.path)).toEqual(['f1.txt', 'other.txt']);
    });

    it('a conflict stops with the files conflicted; its Undo asks, then discards what the run changed', async () => {
      const { t, s1, s2 } = await conflictingSide();
      await t.write('mine.txt', 'untouched\n');
      const { ctx, id, wt } = await openForWrite(t);
      const r = await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [s2, s1], noCommit: true, expect: NO_EXPECT, confirm }, ctx);
      expect(r.outcome).toEqual({ status: 'stopped', files: 1, at: s1, applied: 0, committed: false });
      expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
      const entry = ctx.writes.journal(wt).undoTop()!;
      expect(entry.stoppedPick).toEqual({ op: 'cherry-pick', paths: ['a.txt'] });
      expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toContain('<<<<<<< HEAD');
      // The user resolves a.txt, then asks for the Undo.
      await t.write('a.txt', 'resolved\n');
      await t.stage('a.txt');
      const asked = await undoHandlers.undo({ repo: id, worktree: wt, entry: entry.id }, ctx).catch((e) => e);
      expect(asked).toMatchObject({
        kind: 'Conflict',
        message: 'Undo the stopped cherry-pick? Its changes are discarded, including anything you resolved since.',
        detail: { kind: 'undoStoppedPick', op: 'cherry-pick', arm: "Click again to undo: discards the stopped cherry-pick's changes" },
      });
      expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe('resolved\n');
      const u = await undoHandlers.undo({ repo: id, worktree: wt, entry: entry.id, confirmDiscard: true }, ctx);
      expect(u.outcome).toMatchObject({ status: 'done' });
      expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe('main\n');
      expect(t.memfs.readFileSync(`${t.dir}/mine.txt`, 'utf8')).toBe('untouched\n');
      expect(u.journal.redo).toBeNull();
      expect(u.journal.undo).toBeNull();
    });

    it('a stopped pick is excluded from out-of-order checks, in both directions', async () => {
      const { t, s1, s2 } = await conflictingSide();
      const { ctx, id, wt } = await openForWrite(t);
      const first = await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [s2], noCommit: true, expect: NO_EXPECT, confirm }, ctx);
      await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [s1], noCommit: true, expect: NO_EXPECT, confirm }, ctx);
      const j = ctx.writes.journal(wt);
      const stopped = j.undoTop()!;
      expect(stopped.stoppedPick).not.toBeNull();
      // It can't itself be undone out of order (eligible), and it blocks the older entry (touched).
      expect(j.outOfOrder(stopped.id, null)).toEqual({ why: 'Only Undo of the actions after it can reach this one' });
      expect(j.outOfOrder(first.journal.undo!.entry, null)).toEqual({ why: `A later action can't be checked (${stopped.label})` });
    });

    it('a failure after an applied commit keeps a stopped-pick entry over what went in; its Undo keeps the user\'s file', async () => {
      const t = await makeTestRepo();
      await t.write('one.txt', 'one\n');
      await t.commit('one');
      await t.branch('feature');
      await t.checkout('feature');
      await t.write('f1.txt', 'f1\n');
      const f1 = await t.commit('Add f1');
      await t.write('d/y.txt', 'y\n');
      const dy = await t.commit('Add d/y');
      await t.checkout('main');
      if (t.memfs.existsSync(`${t.dir}/d`, false)) t.memfs.rmdirSync(`${t.dir}/d`);
      await t.write('d', 'mine\n');
      const { ctx, id, wt } = await openForWrite(t);
      const e = await pickHandlers.cherryPick({ repo: id, worktree: wt, oids: [dy, f1], noCommit: true, expect: NO_EXPECT, confirm }, ctx).catch((err) => err);
      expect(e.message).toContain('untracked working tree files would be overwritten by merge:');
      const entry = ctx.writes.journal(wt).undoTop()!;
      expect(entry.stoppedPick).toEqual({ op: 'cherry-pick', paths: ['f1.txt'] });
      expect(t.memfs.existsSync(`${t.dir}/f1.txt`, false)).toBe(true);
      await undoHandlers.undo({ repo: id, worktree: wt, entry: entry.id, confirmDiscard: true }, ctx);
      expect(t.memfs.existsSync(`${t.dir}/f1.txt`, false)).toBe(false);
      expect(t.memfs.readFileSync(`${t.dir}/d`, 'utf8')).toBe('mine\n');
    });
  });
});
