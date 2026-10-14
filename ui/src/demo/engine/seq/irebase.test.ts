import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import type { RebaseRow } from '../../../api/gen/RebaseRow';
import { readCommit } from '../read/commitText';
import { listFiles } from '../read/trees';
import { commitHandlers } from '../../handlers/commit';
import type { TestRepo } from '../read/testkit';
import { makeTestRepo } from '../read/testkit';
import { readInProgress } from '../writeSeam';
import { openForWrite } from '../writeSeamTest';
import { rebaseHandlers } from '../../handlers/rebase';
import { irebaseShape, rebaseLab, revOf, stackShape, subjects } from './fixtures';
import { rebasePlan } from './plan';
import { rewordCommit } from './irebase';
import { rebaseIntegrate } from './rebase';

describe('interactiveRebase', () => {
  it('reorders, squashes and moves the chips, in one write', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    await git.deleteRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/side' });
    const p = await rebasePlan(t.repo, t.dir, 'feature/c', 'main');
    const by = (s: string) => p.rows.find((r) => r.summary.startsWith(s))!.oid;
    const rows: RebaseRow[] = p.rows.map((r) => ({ oid: r.oid, action: r.summary.startsWith('A3') ? 'squash' : 'pick' }));
    const { ctx, id, wt } = await openForWrite(t);
    const r = await rebaseHandlers.interactiveRebase({ repo: id, worktree: wt, branch: 'feature/c', base: 'main', expect: p.expect, rows, chips: p.chips.map((c) => ({ branch: c.branch, at: { kind: 'row', oid: c.at } })), confirm: { autostash: false } }, ctx);
    expect(r.outcome).toMatchObject({ status: 'done', fastForward: false });
    expect(await subjects(t, 'main', 'feature/c')).toEqual(['A1 Add parser', 'A2 Edit notes', 'B1 Add lexer', 'S1 Side work', 'B2 Refine lexer', 'C1 Edit notes again', 'C2 Polish']);
    expect((await readCommit(t.repo, await t.rev('feature/a'))).message).toBe('A2 Edit notes\n\nA3 Add tests');
    expect(await subjects(t, 'main', 'feature/b')).toEqual(['A1 Add parser', 'A2 Edit notes', 'B1 Add lexer', 'S1 Side work', 'B2 Refine lexer']);
    expect(by('C2')).not.toBe(await t.rev('feature/c'));
  });

  it('refuses a plan the branch moved past', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const p = await rebasePlan(t.repo, t.dir, 'lab', 'main');
    await t.write('late.txt', 'late\n');
    await t.commit('Late');
    const { ctx, id, wt } = await openForWrite(t);
    await expect(rebaseHandlers.interactiveRebase({ repo: id, worktree: wt, branch: 'lab', base: 'main', expect: p.expect, rows: p.rows.map((r) => ({ oid: r.oid, action: 'pick' })), chips: [], confirm: { autostash: false } }, ctx)).rejects.toMatchObject({ kind: 'RefMoved' });
  });

  it('stops "about to commit" at an Edit row; abort at an edit stop keeps the stop\'s work in a stash', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const before = await t.rev('lab');
    const l4 = await revOf(t, 'lab~2');
    const p = await rebasePlan(t.repo, t.dir, 'lab', 'main~1');
    const rows: RebaseRow[] = p.rows.map((r) => ({ oid: r.oid, action: r.summary.startsWith('L5') ? 'edit' : 'pick', ...(r.summary.startsWith('L5') ? { message: 'L5 Add more tests\n' } : {}) }));
    const { ctx, id, wt } = await openForWrite(t);
    const r = await rebaseHandlers.interactiveRebase({ repo: id, worktree: wt, branch: 'lab', base: 'main~1', expect: p.expect, rows, chips: [], confirm: { autostash: false } }, ctx);
    expect(r.outcome).toEqual({ status: 'stopped', kind: 'rebase', files: 0 });
    const st = readInProgress(t.memfs, t.repo.gitdir);
    // main~1 is the base, so L1–L4 keep their ids and L5's base is L4.
    expect(st).toMatchObject({ kind: 'rebase', gitvolt: true, editBase: l4, editStop: expect.any(String), message: 'L5 Add more tests\n', editAdded: ['file_2.txt'] });
    await t.write('extra.txt', 'made at the stop\n');
    await t.stage('extra.txt');
    const aborted = await rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'abort' }, ctx);
    expect(aborted.outcome).toMatchObject({ status: 'aborted', stash: expect.any(String) });
    expect(await t.rev('lab')).toBe(before);
    // F10: the stash is listed, with the core's kept record and its banner.
    const stash = (aborted.outcome as { stash: string }).stash;
    expect(ctx.writes.journal(t.dir).state(null).banners).toMatchObject([{ kind: 'abortedWork', stash, label: 'abort the rebase of lab', target: null }]);
    // UX N: HEAD's tree (L4) with only what can't be had again: the stop's own changes (file_2.txt) aren't.
    expect([...(await listFiles(t.repo, stash)).keys()]).toEqual(['extra.txt', 'file_1.txt', 'notes.txt']);
  });

  it('continues an Edit stop with the staged changes and the row\'s message', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const p = await rebasePlan(t.repo, t.dir, 'lab', 'main~1');
    const rows: RebaseRow[] = p.rows.map((r) => ({ oid: r.oid, action: r.summary.startsWith('L5') ? 'edit' : 'pick' }));
    const { ctx, id, wt } = await openForWrite(t);
    await rebaseHandlers.interactiveRebase({ repo: id, worktree: wt, branch: 'lab', base: 'main~1', expect: p.expect, rows, chips: [], confirm: { autostash: false } }, ctx);
    await t.write('more.txt', 'more\n');
    await t.stage('more.txt');
    const done = await rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'continue', message: 'L5 Add tests and more\n' }, ctx);
    expect(done.outcome).toMatchObject({ status: 'done' });
    expect(await subjects(t, 'main~1', 'lab')).toEqual(['L1 Add parser', 'L2 Reword line two', 'L3 Append four', 'L4 Refine four', 'L5 Add tests and more', 'L6 Add docs']);
  });
});

/** lab rebased onto main~1 with Edit rows at `edits` (subject prefixes); its context. */
async function editing(t: TestRepo, edits: string[], base = 'main~1') {
  return planned(t, base, (s) => ({ action: edits.some((e) => s.startsWith(e)) ? 'edit' : 'pick' }));
}

const readFile = (t: TestRepo, path: string) => t.memfs.promises.readFile(`${t.dir}/${path}`, 'utf8');

/** lab rebased onto `base`, each row as `rowOf` says from its summary; its context. */
async function planned(t: TestRepo, base: string, rowOf: (summary: string) => Omit<RebaseRow, 'oid'>) {
  await rebaseLab(t);
  const before = await t.rev('lab');
  const p = await rebasePlan(t.repo, t.dir, 'lab', base);
  const rows: RebaseRow[] = p.rows.map((r) => ({ oid: r.oid, ...rowOf(r.summary) }));
  const { ctx, id, wt } = await openForWrite(t);
  const r = await rebaseHandlers.interactiveRebase({ repo: id, worktree: wt, branch: 'lab', base, expect: p.expect, rows, chips: [], confirm: { autostash: false } }, ctx);
  const commit = (summary: string, amend = false) => commitHandlers.commit({ repo: id, worktree: wt, summary, description: '', amend, stageAll: false, expect: { head: null, refs: {} } }, ctx);
  const control = (action: 'continue' | 'skip' | 'abort', message?: string) => rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action, ...(message !== undefined ? { message } : {}) }, ctx);
  return { ctx, r, before, commit, control, journal: () => ctx.writes.journal(t.dir).state(null) };
}

describe('the interactive rebase\'s stops', () => {
  it('takes commits at an Edit stop (F9); Continue then completes it, settled as one entry', async () => {
    const t = await makeTestRepo();
    const { r, commit, control, journal } = await editing(t, ['L5']);
    expect(r.outcome).toMatchObject({ status: 'stopped' });
    expect(journal().paused).toMatchObject({ kind: 'rebase', irebase: true });
    await expect(commit('L5 part', true)).rejects.toMatchObject({ kind: 'InvalidInput', message: "Nothing to amend yet: this commit's changes are staged. Commit them, or Continue." });
    // The stop's changes, in two pieces: file_2.txt now, more.txt with Continue.
    expect((await commit('L5 part one')).outcome).toMatchObject({ oid: expect.any(String) });
    await t.write('more.txt', 'more\n');
    await t.stage('more.txt');
    const done = await control('continue');
    expect(done.outcome).toMatchObject({ status: 'done' });
    expect(await subjects(t, 'main~1', 'lab')).toEqual(['L1 Add parser', 'L2 Reword line two', 'L3 Append four', 'L4 Refine four', 'L5 part one', 'L5 Add tests', 'L6 Add docs']);
    // Completed, not aborted: the piece counts as the rebase's own (`made`).
    expect(journal()).toMatchObject({ paused: null, undo: { label: 'interactive rebase lab onto main~1' } });
  });

  it('a commit at a stop rides an Abort onto the work branch; a later stop keeps the session', async () => {
    const t = await makeTestRepo();
    const { before, commit, control, journal } = await editing(t, ['L3', 'L5']);
    expect((await control('continue')).outcome).toMatchObject({ status: 'stopped' });
    // Still GitVolt's session: a Commit there is taken.
    expect(journal().paused).toMatchObject({ irebase: true });
    const piece = (await commit('L5, a piece')).outcome!.oid;
    const aborted = await control('abort');
    expect(aborted.outcome).toEqual({ status: 'aborted', branch: 'lab-rebase-work' });
    expect(await t.rev('lab-rebase-work')).toBe(piece);
    expect(await t.rev('lab')).toBe(before);
    expect(journal()).toMatchObject({ paused: null, banners: [] });
  });

  it("keeps nothing of a conflict stop left as git made it, and a hand resolution in a stash (UX N)", async () => {
    const t = await makeTestRepo();
    const { r, control } = await editing(t, [], 'main');
    expect(r.outcome).toEqual({ status: 'stopped', kind: 'rebase', files: 1 });
    expect(await control('abort').then((a) => a.outcome)).toEqual({ status: 'aborted' });
    const u = await makeTestRepo();
    const second = await editing(u, [], 'main');
    await u.write('notes.txt', 'one\ntwo, both\nthree\n');
    await u.stage('notes.txt');
    const kept = await second.control('abort');
    expect(kept.outcome).toMatchObject({ status: 'aborted', stash: expect.any(String) });
    expect(Object.keys(kept.outcome!)).toEqual(['status', 'stash']);
  });

  it('counts every todo line as git does: the exec after a reword, the update-refs', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const p = await rebasePlan(t.repo, t.dir, 'feature/c', 'main~1');
    const [c, b, a] = p.rows;
    const rows: RebaseRow[] = [{ oid: c.oid, action: 'pick' }, { oid: b.oid, action: 'edit' }, { oid: a.oid, action: 'reword', message: 'A, reworded' }];
    const { ctx, id, wt } = await openForWrite(t);
    await rebaseHandlers.interactiveRebase({ repo: id, worktree: wt, branch: 'feature/c', base: 'main~1', expect: p.expect, rows, chips: p.chips.map((x) => ({ branch: x.branch, at: { kind: 'row', oid: x.at } })), confirm: { autostash: false } }, ctx);
    // pick a, exec, update-ref feature/a, edit b (stopped here), update-ref feature/b, pick c.
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ step: 4, total: 6, gitvolt: true });
  });

  it('deletes a chip and makes a new one once it completes', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    await git.deleteRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/side' });
    const p = await rebasePlan(t.repo, t.dir, 'feature/c', 'main');
    const a1 = p.rows.find((r) => r.summary.startsWith('A1'))!.oid;
    const chips = p.chips.map((c) => ({ branch: c.branch, at: c.branch === 'feature/a' ? { kind: 'delete' as const } : { kind: 'row' as const, oid: c.at } }));
    const { ctx, id, wt } = await openForWrite(t);
    const r = await rebaseHandlers.interactiveRebase({ repo: id, worktree: wt, branch: 'feature/c', base: 'main', expect: p.expect, rows: p.rows.map((x) => ({ oid: x.oid, action: 'pick' })), chips: [...chips, { branch: 'feature/n', at: { kind: 'new', oid: a1 } }], confirm: { autostash: false } }, ctx);
    expect(r.outcome).toMatchObject({ status: 'done' });
    expect(r.outcome).not.toHaveProperty('warning');
    await expect(t.rev('feature/a')).rejects.toThrow();
    expect(await subjects(t, 'main', 'feature/n')).toEqual(['A1 Add parser']);
  });
});

describe('fix round 1', () => {
  it('an Abort over an untracked file in the way is refused as git refuses it; the stop\'s own file is cleared', async () => {
    const t = await makeTestRepo();
    const { before, control } = await editing(t, ['L5']);
    // The stop's commit adds file_2.txt; unstaged, it's untracked with exactly that content.
    await git.remove({ fs: t.memfs, dir: t.dir, filepath: 'file_2.txt' });
    await t.write('file_2.txt', 'mine now\n');
    const head = await t.rev('HEAD');
    await expect(control('abort')).rejects.toMatchObject({ kind: 'DirtyWorktree', message: 'The following untracked working tree files would be overwritten by reset:' });
    expect([await t.rev('HEAD'), await readFile(t, 'file_2.txt'), readInProgress(t.memfs, t.repo.gitdir)?.kind]).toEqual([head, 'mine now\n', 'rebase']);
    await t.write('file_2.txt', 'L5 Add tests\n');
    expect((await control('abort')).outcome).toEqual({ status: 'aborted' });
    expect([await t.rev('lab'), await readFile(t, 'file_2.txt')]).toEqual([before, 'L5 Add tests\n']);
  });

  it("a plain rebase's Abort is refused over an untracked file in the way, its content orig-head's or not", async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const { ctx, id, wt } = await openForWrite(t);
    const r = await rebaseIntegrate(ctx, { repo: id, worktree: wt, target: 'main', expect: { head: null, refs: {} }, confirm: { autostash: false } });
    expect(r.outcome).toMatchObject({ status: 'stopped', files: 1 });
    await t.write('file_2.txt', 'L5 Add tests\n');
    await expect(rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'abort' }, ctx)).rejects.toMatchObject({ kind: 'DirtyWorktree' });
  });

  it("a reword's message goes in after its fixup is skipped; its pick's conflict shows the original (git's)", async () => {
    const t = await makeTestRepo();
    const { r, control } = await planned(t, 'main', (s) => (s.startsWith('L1') ? { action: 'reword', message: 'L1 reworded' } : s.startsWith('L2') ? { action: 'fixup' } : { action: 'drop' }));
    expect(r.outcome).toMatchObject({ status: 'stopped', files: 1 });
    expect((await control('skip')).outcome).toMatchObject({ status: 'done' });
    expect(await subjects(t, 'main', 'lab')).toEqual(['L1 reworded']);
    const u = await makeTestRepo();
    const second = await planned(u, 'main', (s) => (s.startsWith('L2') ? { action: 'reword', message: 'L2 reworded' } : s.startsWith('L1') ? { action: 'pick' } : { action: 'drop' }));
    expect(readInProgress(u.memfs, u.repo.gitdir)).toMatchObject({ message: expect.stringMatching(/^L2 Reword line two\n/) });
    await u.write('notes.txt', 'one\ntwo, both\nthree\n');
    await u.stage('notes.txt');
    expect((await second.control('continue')).outcome).toMatchObject({ status: 'done' });
    expect(await subjects(u, 'main', 'lab')).toEqual(['L1 Add parser', 'L2 reworded']);
  });

  it("a squash group whose target is skipped folds into the commit below, keeping its message (git's)", async () => {
    const t = await makeTestRepo();
    const { control } = await planned(t, 'main', (s) => ({ action: s.startsWith('L1') || s.startsWith('L2') ? 'pick' : s.startsWith('L5') ? 'squash' : 'drop' }));
    expect((await control('skip')).outcome).toMatchObject({ status: 'done' });
    expect(await subjects(t, 'main', 'lab')).toEqual(['L1 Add parser']);
    expect([...(await listFiles(t.repo, await t.rev('lab'))).keys()]).toEqual(['file_1.txt', 'file_2.txt', 'notes.txt']);
  });

  it('a stop refused again keeps the visitor\'s staged edits theirs: Abort stashes them', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const p = await rebasePlan(t.repo, t.dir, 'feature/c', 'main');
    const { ctx, id, wt } = await openForWrite(t);
    const rows: RebaseRow[] = p.rows.map((r) => ({ oid: r.oid, action: r.summary.endsWith('feature/c') ? 'edit' : 'pick' }));
    await rebaseHandlers.interactiveRebase({ repo: id, worktree: wt, branch: 'feature/c', base: 'main', expect: p.expect, rows, chips: p.chips.map((c) => ({ branch: c.branch, at: { kind: 'row', oid: c.at } })), confirm: { autostash: false } }, ctx);
    // feature/a moves meanwhile: the finish can't move it, and stops.
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/feature/a', value: await t.rev('main'), force: true });
    const control = (action: 'continue' | 'abort') => rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action }, ctx);
    expect((await control('continue')).outcome).toMatchObject({ status: 'stopped', files: 0, warning: expect.stringContaining('The rebase stopped: update_ref failed') });
    await t.write('main.txt', 'edited while stopped\n');
    await t.stage('main.txt');
    expect((await control('continue')).outcome).toMatchObject({ status: 'stopped', files: 0 });
    const aborted = (await control('abort')).outcome as { stash?: string };
    const stashed = (await listFiles(t.repo, aborted.stash!)).get('main.txt')!;
    expect(new TextDecoder().decode((await git.readBlob({ fs: t.memfs, dir: t.dir, oid: stashed.oid })).blob)).toBe('edited while stopped\n');
  });
});

describe('rewordCommit', () => {
  it('rewords a stacked commit and moves the branches above it', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const main = await t.rev('main');
    const { ctx, id, wt } = await openForWrite(t);
    const r = await rewordCommit(ctx, { repo: id, worktree: wt, oid: await t.rev('feature/a'), message: 'Work on A, reworded\n', expect: { head: await t.rev('HEAD'), refs: {} }, confirm: { autostash: false } });
    expect(r.outcome).toMatchObject({ status: 'done', rewritten: await t.rev('feature/a') });
    expect(await subjects(t, 'main~1', 'feature/c')).toEqual(['Work on A, reworded', 'Work on feature/b', 'Work on feature/c']);
    expect(await t.rev('main')).toBe(main);
  });

  it('refuses a root commit, an empty summary, and a commit on the trunk from another branch', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const { ctx, id, wt } = await openForWrite(t);
    const root = await revOf(t, 'main~1');
    const ask = (oid: string, message: string) => rewordCommit(ctx, { repo: id, worktree: wt, oid, message, expect: { head: null, refs: {} }, confirm: { autostash: false } });
    await expect(ask(root, '  \n')).rejects.toMatchObject({ message: 'Write a commit summary' });
    await expect(ask(root, 'New\n')).rejects.toMatchObject({ message: 'The first commit can\'t be reworded here. Use Interactive rebase.' });
    // A commit main has too, reworded from feature/c, would copy main's history into it.
    const u = await makeTestRepo();
    await u.write('a.txt', 'a\n');
    await u.commit('A');
    const shared = await u.commit('B');
    await u.branch('topic');
    await u.checkout('topic');
    await u.write('c.txt', 'c\n');
    await u.commit('C');
    const o = await openForWrite(u);
    await expect(rewordCommit(o.ctx, { repo: o.id, worktree: o.wt, oid: shared, message: 'B2', expect: { head: null, refs: {} }, confirm: { autostash: false } })).rejects.toMatchObject({ message: "That commit is on main too. Rewording it here would copy main's history into this branch." });
  });

  it('refuses a range with merges, and a commit not in the branch', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    const { ctx, id, wt } = await openForWrite(t);
    const ask = async (s: string) => rewordCommit(ctx, { repo: id, worktree: wt, oid: await revOf(t, s), message: 'New', expect: { head: null, refs: {} }, confirm: { autostash: false } });
    await expect(ask('feature/a~2')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'This would flatten 1 merge commit: use the interactive rebase editor' });
    await expect(ask('main')).rejects.toMatchObject({ kind: 'InvalidInput', message: "That commit isn't in feature/c's history any more" });
  });
});
