import { describe, expect, it } from 'vitest';
import { fakeCtx, makeTestRepo, setIndex } from '../engine/read/testkit';
import { wipStaged, wipUnstaged } from '../engine/read/changes';
import { loadIndex } from '../engine/write/index';
import { mainWt } from '../engine/write/seam';
import { journalHandlers } from './journal';
import { stageHandlers } from './stage';

async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a1\n');
  await t.write('gone.txt', 'g\n');
  await t.write('space name.txt', 'one\n');
  await t.write('dir with space/ünï.txt', 'u\n');
  await t.commit('Base');
  await t.write('a.txt', 'a2\n');
  await t.remove('gone.txt');
  await t.write('space name.txt', 'one\ntwo\n');
  await t.write('dir with space/ünï.txt', 'u2\n');
  await t.write('new/fresh.txt', 'fresh\n');
  return { t, ctx: fakeCtx(t.repo) };
}

const staged = async (t: Awaited<ReturnType<typeof makeTestRepo>>) => (await wipStaged(t.repo, t.dir)).map((f) => `${f.status} ${f.path}`);
const unstaged = async (t: Awaited<ReturnType<typeof makeTestRepo>>) => (await wipUnstaged(t.repo, t.dir)).map((f) => `${f.status} ${f.path}`);

describe('stage and unstage', () => {
  it('refuses the whole add when a path is beyond a symlink, as git does', async () => {
    const { t, ctx } = await repo();
    await t.link('ln', 'new');
    await t.write('new/inside.txt', 'x\n');
    await expect(stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt', 'ln/inside.txt'] }, ctx)).rejects.toMatchObject({ kind: 'Other', message: "pathspec 'ln/inside.txt' is beyond a symbolic link" });
    expect(await staged(t)).toEqual([]);
  });

  it('unstaging a conflicted path restores HEAD\'s entry, as git restore --staged does', async () => {
    const { t, ctx } = await repo();
    const idx = await loadIndex(mainWt(t.repo));
    const a = idx.find((e) => e.path === 'a.txt')!;
    await setIndex(t, [...idx.filter((e) => e.path !== 'a.txt'), ...[1, 2, 3].map((stage) => ({ ...a, stage }))]);
    await stageHandlers.unstage({ repo: 1, worktree: t.dir, paths: ['a.txt'], oldPaths: [] }, ctx);
    expect((await loadIndex(mainWt(t.repo))).filter((e) => e.path === 'a.txt').map((e) => [e.stage, e.oid])).toEqual([[0, a.oid]]);
  });

  it('stages and unstages whole files, awkward paths literally (Review Focus 3)', async () => {
    const { t, ctx } = await repo();
    const r = await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt', 'gone.txt', 'space name.txt', 'dir with space/ünï.txt', 'new'] }, ctx);
    expect(r.staging.undo).toBe('stage 5 files');
    expect(await staged(t)).toEqual(['M a.txt', 'M dir with space/ünï.txt', 'D gone.txt', 'A new/fresh.txt', 'M space name.txt']);
    expect(r.wip?.staged.files.length).toBe(5);
    await stageHandlers.unstage({ repo: 1, worktree: t.dir, paths: ['space name.txt'], oldPaths: [] }, ctx);
    expect(await staged(t)).not.toContain('M space name.txt');
    expect(await unstaged(t)).toContain('M space name.txt');
  });

  it('refuses a path that matches nothing, changing nothing', async () => {
    const { t, ctx } = await repo();
    const before = await loadIndex(mainWt(t.repo));
    await expect(stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['nope.txt', 'a.txt'] }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'nope.txt changed since it was shown' });
    await expect(stageHandlers.stage({ repo: 1, worktree: t.dir, paths: [] }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Nothing to stage' });
    expect(await loadIndex(mainWt(t.repo))).toEqual(before);
  });

  it('stages all and unstages all', async () => {
    const { t, ctx } = await repo();
    expect((await stageHandlers.stageAll({ repo: 1, worktree: t.dir }, ctx)).staging.undo).toBe('stage all');
    expect(await unstaged(t)).toEqual([]);
    await stageHandlers.unstageAll({ repo: 1, worktree: t.dir }, ctx);
    expect(await staged(t)).toEqual([]);
  });

  it('a same-size edit right after a stage stays unstaged (Review Focus 2)', async () => {
    const { t, ctx } = await repo();
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    expect(await unstaged(t)).not.toContain('M a.txt');
    await t.write('a.txt', 'a3\n');
    expect(await unstaged(t)).toContain('M a.txt');
  });

  it('unstages with rm --cached while HEAD is unborn', async () => {
    const t = await makeTestRepo();
    const ctx = fakeCtx(t.repo);
    await t.write('first.txt', 'first\n');
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['first.txt'] }, ctx);
    expect((await loadIndex(mainWt(t.repo))).map((e) => e.path)).toEqual(['first.txt']);
    await stageHandlers.unstage({ repo: 1, worktree: t.dir, paths: ['first.txt'] }, ctx);
    expect(await loadIndex(mainWt(t.repo))).toEqual([]);
    expect(t.memfs.existsSync(`${t.dir}/first.txt`)).toBe(true);
  });

  it('undoes and redoes staging steps, and clears the log over an outside change', async () => {
    const { t, ctx } = await repo();
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['a.txt'] }, ctx);
    await stageHandlers.stage({ repo: 1, worktree: t.dir, paths: ['new'] }, ctx);
    const u = await journalHandlers.stagingUndo({ repo: 1, worktree: t.dir }, ctx);
    expect([u.staging, await staged(t)]).toEqual([{ undo: 'stage a.txt', redo: 'stage new', off: null }, ['M a.txt']]);
    await journalHandlers.stagingRedo({ repo: 1, worktree: t.dir }, ctx);
    expect(await staged(t)).toEqual(['M a.txt', 'A new/fresh.txt']);
    // An outside `git add` (a test write straight to the index) since the step: refused, log cleared.
    await t.stage('space name.txt');
    await expect(journalHandlers.stagingUndo({ repo: 1, worktree: t.dir }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'The index changed outside staging; staging history was cleared.' });
    await expect(journalHandlers.stagingUndo({ repo: 1, worktree: t.dir }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'Nothing to undo in staging' });
  });
});
