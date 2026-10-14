import { describe, expect, it } from 'vitest';
import { readCommit } from '../engine/read/commitText';
import { fakeCtx, makeTestRepo } from '../engine/read/testkit';
import { loadIndex, saveIndex } from '../engine/write/index';
import { mergeBaseOf } from '../engine/read/revs';
import { refuseLocalChanges } from '../engine/write/mergeRun';
import { mergeMessage } from '../engine/write/mergeState';
import { mergeTrees } from '../engine/write/mergeTrees';
import { hardReset } from '../engine/write/move';
import { writeCommitObject, writeTagObject } from '../engine/write/objects';
import { casRefs, readHead, readRef, setHead } from '../engine/write/refs';
import { mainWt } from '../engine/write/seam';
import { stashList } from '../engine/write/stash';
import { statusEntries } from '../engine/write/status';
import { commitHandlers } from './commit';
import { journalHandlers } from './journal';
import { mergeHandlers } from './merge';
import { stageHandlers } from './stage';

const NO = { head: null, refs: {} };
const CONFIRM = { autostash: false };

/** base: a.txt 1/2/3, b.txt. feature changes a.txt's line 2 (F); main changes b.txt, or a.txt's line 2 (M) when `conflicting`. */
async function repo(conflicting: boolean) {
  const t = await makeTestRepo();
  await t.write('a.txt', '1\n2\n3\n');
  await t.write('b.txt', 'b\n');
  const base = await t.commit('Base');
  await t.branch('feature', base);
  await t.checkout('feature');
  await t.write('a.txt', '1\nF\n3\n');
  const feature = await t.commit('Feature');
  await t.checkout('main');
  if (conflicting) await t.write('a.txt', '1\nM\n3\n');
  else await t.write('b.txt', 'b2\n');
  const main = await t.commit('Main');
  return { t, base, feature, main, ctx: fakeCtx(t.repo), wt: mainWt(t.repo) };
}

const merge = (ctx: ReturnType<typeof fakeCtx>, dir: string, target: string, ffOnly = false) =>
  mergeHandlers.integrate({ repo: 1, worktree: dir, kind: 'merge', target, ...(ffOnly ? { ffOnly } : {}), expect: NO, confirm: CONFIRM }, ctx);

describe('merge', () => {
  it('makes a merge commit as the visitor, journaled as a Rewind', async () => {
    const { t, feature, main, ctx, wt } = await repo(false);
    const r = await merge(ctx, t.dir, 'feature');
    const head = readHead(wt);
    const c = await readCommit(t.repo, head.oid!);
    // The tree is git 2.53's for the same merge.
    expect([r.outcome, c.parents, c.tree, c.rawMessage, c.author.name]).toEqual([{ status: 'done', commits: 2, fastForward: false }, [main, feature], '7f7bcd8ef0280765c91f33ef97450e3727b8224f', "Merge branch 'feature'\n", 'You']);
    expect([t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), r.journal.undo?.label, ctx.writes.journal(t.dir).undoTop()?.undo]).toEqual(['1\nF\n3\n', 'merge feature into main', 'rewind']);
    expect([t.memfs.readFileSync(`${t.repo.gitdir}/ORIG_HEAD`, 'utf8'), t.memfs.existsSync(`${t.repo.gitdir}/MERGE_HEAD`), await statusEntries(t.repo, t.dir)]).toEqual([`${main}\n`, false, []]);
    expect((await merge(ctx, t.dir, 'feature')).outcome).toEqual({ status: 'upToDate' });
  });

  it('fast-forwards when it can, and --ff-only refuses when it cannot', async () => {
    const { t, base, feature, ctx, wt } = await repo(false);
    await expect(merge(ctx, t.dir, 'feature', true)).rejects.toMatchObject({ kind: 'NonFastForward', message: 'Not possible to fast-forward, aborting.' });
    await t.branch('behind', base);
    await t.checkout('behind');
    setHead(wt, { branch: 'behind' });
    const r = await merge(ctx, t.dir, 'feature');
    expect([r.outcome, readHead(wt), r.journal.undo?.label]).toEqual([{ status: 'done', commits: 1, fastForward: true }, { branch: 'behind', oid: feature }, 'merge feature into behind']);
  });

  it('stops on a conflict with the merge files, markers and a paused entry, and Commit completes it', async () => {
    const { t, feature, main, ctx } = await repo(true);
    const r = await merge(ctx, t.dir, 'feature');
    expect(r.outcome).toEqual({ status: 'stopped', kind: 'merge', files: 1 });
    expect([t.memfs.readFileSync(`${t.repo.gitdir}/MERGE_HEAD`, 'utf8'), t.memfs.readFileSync(`${t.repo.gitdir}/MERGE_MSG`, 'utf8'), t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')]).toEqual([
      `${feature}\n`,
      "Merge branch 'feature'\n\n# Conflicts:\n#\ta.txt\n",
      '1\n<<<<<<< HEAD\nM\n=======\nF\n>>>>>>> feature\n3\n',
    ]);
    // git 2.53's for the same trees: MERGE_MODE empty, AUTO_MERGE the result's tree with its markers.
    expect([t.memfs.readFileSync(`${t.repo.gitdir}/MERGE_MODE`, 'utf8'), t.memfs.readFileSync(`${t.repo.gitdir}/AUTO_MERGE`, 'utf8'), (await loadIndex(mainWt(t.repo))).map((e) => `${e.oid} ${e.stage}\t${e.path}`)]).toEqual([
      '',
      '8b5162f4b49a3004d608c16f4d67c4e7aa585e98\n',
      ['01e79c32a8c99c557f0757da7cb6d65b3414466d 1\ta.txt', 'e95635a8eae8594d2b02938195eb45a8e170a8cd 2\ta.txt', '425b96cf59fb03832372cc2bf90366dda1880601 3\ta.txt', '61780798228d17af2d34fce4cfbdf35556832472 0\tb.txt'],
    ]);
    expect(r.journal.paused).toEqual({ entry: expect.any(Number), kind: 'merge', label: 'merge feature into main', target: 'feature', irebase: false });
    expect(r.journal.undoBlocked).toBe('Finish or abort the merge first');
    await t.write('a.txt', '1\nM and F\n3\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const done = await commitHandlers.commit({ repo: 1, worktree: t.dir, summary: "Merge branch 'feature'", description: '', amend: false, stageAll: false, expect: NO }, ctx);
    expect((await readCommit(t.repo, done.outcome.oid)).parents).toEqual([main, feature]);
    const j = ctx.writes.journal(t.dir);
    expect([j.undo.map((e) => [e.label, e.state, e.undo]), done.journal.paused, done.journal.undo?.label]).toEqual([[['merge feature into main', 'done', 'rewind']], null, 'merge feature into main']);
    expect(j.undoTop()?.refs).toEqual([{ name: 'refs/heads/main', old: main, new: done.outcome.oid }]);
    expect(['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE'].map((f) => t.memfs.existsSync(`${t.repo.gitdir}/${f}`))).toEqual([false, false, false, false]);
  });

  it('aborts a conflicted merge back to HEAD and drops the paused entry', async () => {
    const { t, ctx } = await repo(true);
    await merge(ctx, t.dir, 'feature');
    const r = await mergeHandlers.mergeAbort({ repo: 1, worktree: t.dir }, ctx);
    expect([r.outcome, t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), t.memfs.existsSync(`${t.repo.gitdir}/MERGE_HEAD`), await statusEntries(t.repo, t.dir), r.journal.paused]).toEqual([{ status: 'aborted' }, '1\nM\n3\n', false, [], null]);
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
    await expect(mergeHandlers.mergeAbort({ repo: 1, worktree: t.dir }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'No merge is in progress' });
  });

  // As `git merge --abort` does on the same steps: a local change from before the merge stays, an
  // edit to a path the merge staged refuses (changing nothing), a staged new file goes, an untracked one stays.
  it('abort keeps local changes the merge left alone and refuses over an edit to a merged path', async () => {
    const { t, ctx } = await repo(true);
    await t.write('b.txt', 'b, mine\n');
    await merge(ctx, t.dir, 'feature');
    await t.write('a.txt', 'edited\n');
    await t.write('s.txt', 's\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['s.txt'] }, ctx);
    await t.write('s.txt', 's2\n');
    await expect(mergeHandlers.mergeAbort({ repo: 1, worktree: t.dir }, ctx)).rejects.toMatchObject({ kind: 'DirtyWorktree', message: "Entry 's.txt' not uptodate. Cannot merge." });
    expect([t.memfs.existsSync(`${t.repo.gitdir}/MERGE_HEAD`), t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')]).toEqual([true, 'edited\n']);
    await t.write('s.txt', 's\n');
    await t.write('u.txt', 'u\n');
    await mergeHandlers.mergeAbort({ repo: 1, worktree: t.dir }, ctx);
    expect([t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), t.memfs.existsSync(`${t.dir}/s.txt`), (await statusEntries(t.repo, t.dir)).map((e) => `${e.index}${e.worktree} ${e.path}`)]).toEqual(['1\nM\n3\n', false, ['.M b.txt', '?? u.txt']]);
  });

  // git 2.53's index, MERGE_MSG and AUTO_MERGE for the same trees, and its abort putting d back.
  it('a file/folder clash stops with the file aside, and abort puts the file back over the folder', async () => {
    const t = await makeTestRepo();
    await t.write('d', 'd1\nd2\n');
    await t.write('k', 'k\n');
    const base = await t.commit('Base');
    await t.branch('feature', base);
    await t.checkout('feature');
    t.memfs.unlinkSync(`${t.dir}/d`);
    await t.write('d/x', 'x\n');
    await t.commit('Feature');
    // isomorphic-git's checkout leaves the folder where main has a file.
    t.memfs.unlinkSync(`${t.dir}/d/x`);
    t.memfs.rmdirSync(`${t.dir}/d`);
    await t.checkout('main');
    await t.write('d', 'O\nd2\n');
    await t.commit('Main');
    const ctx = fakeCtx(t.repo);
    const r = await merge(ctx, t.dir, 'feature');
    const git = (f: string) => t.memfs.readFileSync(`${t.repo.gitdir}/${f}`, 'utf8');
    expect([r.outcome, git('MERGE_MSG'), git('AUTO_MERGE'), (await loadIndex(mainWt(t.repo))).map((e) => `${e.oid} ${e.stage}\t${e.path}`)]).toEqual([
      { status: 'stopped', kind: 'merge', files: 1 },
      "Merge branch 'feature'\n\n# Conflicts:\n#\td~HEAD\n",
      '4a77da91486db172b04c563db025851a69b4b1ae\n',
      ['587be6b4c3f93f93c489c0111bba5596147a26cb 0\td/x', 'ddbe444a0a4f282b9e3841c40ea13ec6e88f14f1 1\td~HEAD', '641fe73c4d40511c2e1b7a3f6709bc5389ae7d6d 2\td~HEAD', 'b68fde2a051d9af2fe3ff4c96c0898e5a3212e4d 0\tk'],
    ]);
    // An untracked file in the folder HEAD's file replaces refuses the abort; an ignored one goes.
    await t.write('d/u', 'u\n');
    await expect(mergeHandlers.mergeAbort({ repo: 1, worktree: t.dir }, ctx)).rejects.toMatchObject({ kind: 'Other', message: "Updating 'd' would lose untracked files in it", stderr: "error: Updating 'd' would lose untracked files in it\nfatal: Could not reset index file to revision 'HEAD'.\n" });
    expect([t.memfs.existsSync(`${t.repo.gitdir}/MERGE_HEAD`), t.memfs.existsSync(`${t.dir}/d/x`)]).toEqual([true, true]);
    await t.write('.git/info/exclude', 'd/u\n');
    await mergeHandlers.mergeAbort({ repo: 1, worktree: t.dir }, ctx);
    expect([t.memfs.readFileSync(`${t.dir}/d`, 'utf8'), t.memfs.existsSync(`${t.dir}/d~HEAD`), await statusEntries(t.repo, t.dir)]).toEqual(['O\nd2\n', false, []]);
  });

  // git 2.53: `reset --merge` won't put HEAD's file back over one the index doesn't have, even alike.
  it('abort refuses over a file the index lost, changing nothing', async () => {
    const { t, ctx, wt } = await repo(true);
    await merge(ctx, t.dir, 'feature');
    await saveIndex(wt, (await loadIndex(wt)).filter((e) => e.path !== 'b.txt'));
    await expect(mergeHandlers.mergeAbort({ repo: 1, worktree: t.dir }, ctx)).rejects.toMatchObject({
      kind: 'DirtyWorktree',
      message: "Untracked working tree file 'b.txt' would be overwritten by merge.",
      stderr: "error: Untracked working tree file 'b.txt' would be overwritten by merge.\nfatal: Could not reset index file to revision 'HEAD'.\n",
    });
    expect([t.memfs.existsSync(`${t.repo.gitdir}/MERGE_HEAD`), t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')]).toEqual([true, '1\n<<<<<<< HEAD\nM\n=======\nF\n>>>>>>> feature\n3\n']);
  });

  // git 2.53's order: the unmerged index refuses before anything else, ORIG_HEAD written after it.
  // The autostash's push meets the unmerged index first (git's `stash push` refuses it), as the core's does.
  it("refuses an unmerged index even when up to date (the autostash's push), and writes ORIG_HEAD on every merge past that", async () => {
    const { t, base, main, ctx, wt } = await repo(true);
    expect((await merge(ctx, t.dir, base)).outcome).toEqual({ status: 'upToDate' });
    expect(t.memfs.readFileSync(`${t.repo.gitdir}/ORIG_HEAD`, 'utf8')).toBe(`${main}\n`);
    await merge(ctx, t.dir, 'feature');
    for (const f of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'ORIG_HEAD']) t.memfs.unlinkSync(`${t.repo.gitdir}/${f}`);
    await expect(merge(ctx, t.dir, base)).rejects.toMatchObject({ kind: 'Other', message: 'could not write index' });
    expect(t.memfs.existsSync(`${t.repo.gitdir}/ORIG_HEAD`)).toBe(false);
    await hardReset(wt, main);
  });

  // git 2.53's stderr and kinds for the same worktrees.
  it('refuses an untracked file where the merge needs a folder, and a folder of untracked files where it writes a file', async () => {
    const { t, ctx, main } = await repo(false);
    await t.checkout('feature');
    await t.write('d/x', 'x\n');
    await t.write('e', 'e\n');
    await t.commit('More');
    // isomorphic-git's checkout leaves what main doesn't have.
    t.memfs.unlinkSync(`${t.dir}/d/x`);
    t.memfs.rmdirSync(`${t.dir}/d`);
    t.memfs.unlinkSync(`${t.dir}/e`);
    await t.checkout('main');
    await t.write('d', 'mine\n');
    const tail = 'Aborting\nMerge with strategy ort failed.\n';
    const untracked = 'error: The following untracked working tree files would be overwritten by merge:\n\td\nPlease move or remove them before you merge.\n';
    await expect(merge(ctx, t.dir, 'feature')).rejects.toMatchObject({ kind: 'DirtyWorktree', message: 'The following untracked working tree files would be overwritten by merge:', stderr: untracked + tail });
    await t.write('e/u', 'u\n');
    const lost = 'error: Updating the following directories would lose untracked files in them:\n\te\n\n';
    await expect(merge(ctx, t.dir, 'feature')).rejects.toMatchObject({ kind: 'DirtyWorktree', stderr: lost + untracked + tail });
    t.memfs.unlinkSync(`${t.dir}/d`);
    await expect(merge(ctx, t.dir, 'feature')).rejects.toMatchObject({ kind: 'Other', message: 'Updating the following directories would lose untracked files in them:', stderr: lost + tail });
    expect([readHead(mainWt(t.repo)).oid, t.memfs.existsSync(`${t.dir}/d`), t.memfs.readFileSync(`${t.dir}/e/u`, 'utf8')]).toEqual([main, false, 'u\n']);
    // An ignored file there just goes, as git's does.
    await t.write('.git/info/exclude', 'e/u\n');
    expect((await merge(ctx, t.dir, 'feature')).outcome).toEqual({ status: 'done', commits: 3, fastForward: false });
    expect(t.memfs.readFileSync(`${t.dir}/e`, 'utf8')).toBe('e\n');
  });

  it('settles a merge that ended outside GitVolt before the next write', async () => {
    const { t, main, ctx, wt } = await repo(true);
    await merge(ctx, t.dir, 'feature');
    for (const f of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) t.memfs.unlinkSync(`${t.repo.gitdir}/${f}`);
    await hardReset(wt, main);
    const r = await journalHandlers.settlePaused({ repo: 1, worktree: t.dir }, ctx);
    expect([r.journal.paused, ctx.writes.journal(t.dir).paused()]).toEqual([null, null]);
  });

  it('settles a merge committed outside GitVolt as completed, with the refs that moved into its history', async () => {
    const { t, base, feature, main, ctx, wt } = await repo(true);
    await t.branch('stacked', main);
    await t.branch('away', main);
    const watched = { 'refs/heads/stacked': main, 'refs/heads/away': main };
    await mergeHandlers.integrate({ repo: 1, worktree: t.dir, kind: 'merge', target: 'feature', expect: { head: null, refs: watched }, confirm: CONFIRM }, ctx);
    // Resolved and committed in a terminal: the merge commit on main, `stacked` moved onto it,
    // `away` moved to a commit outside the new history (someone else's).
    await t.write('a.txt', '1\nM and F\n3\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    const ident = 'Ada Lovelace <ada@example.com> 1800000000 +0000';
    const tree = (await readCommit(t.repo, main)).tree;
    const merged = await writeCommitObject(t.repo, { tree, parents: [main, feature], author: ident, committer: ident, message: "Merge branch 'feature'\n" });
    const elsewhere = await writeCommitObject(t.repo, { tree, parents: [base], author: ident, committer: ident, message: 'Elsewhere\n' });
    casRefs(wt.demo, [
      { name: 'refs/heads/main', old: main, new: merged },
      { name: 'refs/heads/stacked', old: main, new: merged },
      { name: 'refs/heads/away', old: main, new: elsewhere },
    ]);
    for (const f of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) t.memfs.unlinkSync(`${t.repo.gitdir}/${f}`);
    await hardReset(wt, merged);
    const r = await journalHandlers.settlePaused({ repo: 1, worktree: t.dir }, ctx);
    const top = ctx.writes.journal(t.dir).undoTop();
    expect([r.journal.paused, r.journal.undo?.label, top?.state, top?.headAfter, top?.refs]).toEqual([
      null,
      'merge feature into main',
      'done',
      { branch: 'main', oid: merged },
      [
        { name: 'refs/heads/main', old: main, new: merged },
        { name: 'refs/heads/stacked', old: main, new: merged },
      ],
    ]);
  });

  it('autostashes a staged change around the merge, and routes a rebase to plan 4', async () => {
    const { t, ctx, wt } = await repo(false);
    await t.write('c.txt', 'staged\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['c.txt'] }, ctx);
    const r = await merge(ctx, t.dir, 'feature');
    expect([r.outcome, (await statusEntries(t.repo, t.dir)).map((x) => `${x.index}${x.worktree} ${x.path}`), stashList(wt), ctx.writes.journal(t.dir).kept]).toEqual([{ status: 'done', commits: 2, fastForward: false }, ['A. c.txt'], [], []]);
    // feature is in main now: up to date, as git says.
    expect((await mergeHandlers.integrate({ repo: 1, worktree: t.dir, kind: 'rebase', target: 'feature', updateRefs: true, expect: NO, confirm: CONFIRM }, ctx)).outcome).toEqual({ status: 'upToDate' });
  });

  // git 2.53's stderr for the same changes (what the autostash spares the visitor): the unstaged and
  // untracked blocks together; an unstaged change the merge doesn't touch stays through it.
  it('asks first when untracked files it writes would conflict, refuses as git does without an autostash, and keeps a change it does not touch', async () => {
    const { t, ctx, wt, main } = await repo(false);
    await t.checkout('feature');
    await t.write('n.txt', 'n\n');
    await t.write('d/x.txt', 'x\n');
    await t.commit('More');
    await t.checkout('main');
    await t.write('a.txt', '1\n2\n3\nmine\n');
    await t.write('b.txt', 'b2, mine\n');
    await t.write('n.txt', 'untracked\n');
    await t.write('d/x.txt', 'untracked\n');
    await expect(merge(ctx, t.dir, 'feature')).rejects.toMatchObject({ kind: 'Conflict', message: 'Your changes conflict with feature', detail: { kind: 'autostashConflict', paths: ['d/x.txt', 'n.txt'], target: 'feature' } });
    const theirs = readRef(wt.demo, 'refs/heads/feature')!;
    const m = await mergeTrees(wt.repo, (await mergeBaseOf(wt.repo, main, theirs))!, main, theirs, { ours: 'HEAD', theirs: 'feature' });
    const e = await refuseLocalChanges(wt, m).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'DirtyWorktree', message: 'Your local changes to the following files would be overwritten by merge:' });
    expect((e as { stderr: string }).stderr).toBe(
      'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\nPlease commit your changes or stash them before you merge.\n' +
        'error: The following untracked working tree files would be overwritten by merge:\n\td/x.txt\n\tn.txt\nPlease move or remove them before you merge.\nAborting\nMerge with strategy ort failed.\n',
    );
    await t.write('a.txt', '1\n2\n3\n');
    for (const f of ['n.txt', 'd/x.txt']) t.memfs.unlinkSync(`${t.dir}/${f}`);
    const r = await merge(ctx, t.dir, 'feature');
    expect([r.outcome, t.memfs.readFileSync(`${t.dir}/b.txt`, 'utf8'), (await statusEntries(t.repo, t.dir)).map((x) => `${x.index}${x.worktree} ${x.path}`)]).toEqual([{ status: 'done', commits: 3, fastForward: false }, 'b2, mine\n', ['.M b.txt']]);
  });

  // git 2.53's messages for the same targets merged into `topic`.
  it("names what it merges as git does, an annotated tag's message included", async () => {
    const { t, feature, wt } = await repo(false);
    const tag = await writeTagObject(t.repo, { object: feature, name: 'v1', tagger: 'Ada Lovelace <ada@example.com> 1800000000 +0000', message: 'Release one\n\nBody line\n' });
    casRefs(wt.demo, [
      { name: 'refs/tags/v1', old: null, new: tag },
      { name: 'refs/tags/lw1', old: null, new: feature },
      { name: 'refs/remotes/origin/feature', old: null, new: feature },
    ]);
    const msgs = await Promise.all(['feature', 'v1', 'lw1', feature.slice(0, 7), 'origin/feature'].map((x) => mergeMessage(wt, x, 'topic')));
    expect(msgs).toEqual([
      "Merge branch 'feature' into topic\n",
      "Merge tag 'v1' into topic\n\nRelease one\n\nBody line\n",
      "Merge tag 'lw1' into topic\n",
      `Merge commit '${feature.slice(0, 7)}' into topic\n`,
      "Merge remote-tracking branch 'origin/feature' into topic\n",
    ]);
    expect(await mergeMessage(wt, 'feature', 'master')).toBe("Merge branch 'feature'\n");
  });
});
