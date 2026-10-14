import { describe, expect, it } from 'vitest';
import { wipStaged, wipUnstaged } from '../engine/read/changes';
import { fakeCtx, makeTestRepo, setIndex, thirty, writeNested } from '../engine/read/testkit';
import { MODE_FILE, MODE_GITLINK } from '../engine/read/trees';
import { baseOf } from '../engine/read/wipDiff';
import { loadIndex } from '../engine/write/index';
import { mainWt } from '../engine/write/seam';
import { discardHandlers } from './discard';
import { stageHandlers } from './stage';

async function repo() {
  const t = await makeTestRepo();
  await t.write('f.txt', thirty([]));
  await t.write('b.bin', new Uint8Array([0, 1]));
  await t.commit('Base');
  await t.write('f.txt', thirty([3, 20]));
  await t.write('b.bin', new Uint8Array([0, 2]));
  await t.write('new.txt', 'one\ntwo\nthree\n');
  return { t, ctx: fakeCtx(t.repo) };
}
const counts = async (t: Awaited<ReturnType<typeof makeTestRepo>>, path: string) => {
  const s = (await wipStaged(t.repo, t.dir)).find((f) => f.path === path);
  const u = (await wipUnstaged(t.repo, t.dir)).find((f) => f.path === path);
  return [s ? [s.additions, s.deletions] : null, u ? [u.additions, u.deletions] : null];
};

describe('stagePatch', () => {
  it('stages a hunk, then lines, then unstages a hunk', async () => {
    const { t, ctx } = await repo();
    const r = await stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false, selection: { kind: 'hunks', hunks: [0] }, base: await baseOf(t.repo, t.dir, 'f.txt') }, ctx);
    expect(r.staging.undo).toBe('stage a hunk in f.txt');
    expect(await counts(t, 'f.txt')).toEqual([[1, 1], [1, 1]]);
    await stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false, selection: { kind: 'lines', old: [{ start: 20, end: 20 }], new: [] }, base: await baseOf(t.repo, t.dir, 'f.txt') }, ctx);
    expect(await counts(t, 'f.txt')).toEqual([[1, 2], [1, 0]]);
    await stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: true, selection: { kind: 'hunks', hunks: [0] }, base: await baseOf(t.repo, t.dir, 'f.txt') }, ctx);
    expect(await counts(t, 'f.txt')).toEqual([[0, 1], [2, 1]]);
  });

  it('stages part of a new file, and unstaging all of it takes it out of the index', async () => {
    const { t, ctx } = await repo();
    await stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'new.txt', staged: false, selection: { kind: 'lines', old: [], new: [{ start: 1, end: 2 }] }, base: await baseOf(t.repo, t.dir, 'new.txt') }, ctx);
    expect(await counts(t, 'new.txt')).toEqual([[2, 0], [1, 0]]);
    await stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'new.txt', staged: true, selection: { kind: 'hunks', hunks: [0] }, base: await baseOf(t.repo, t.dir, 'new.txt') }, ctx);
    expect((await loadIndex(mainWt(t.repo))).some((e) => e.path === 'new.txt')).toBe(false);
  });

  it('stages the whole of a deleted file as its deletion, and part of it as a modification', async () => {
    const { t, ctx } = await repo();
    await t.remove('f.txt');
    await stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false, selection: { kind: 'lines', old: [{ start: 1, end: 2 }], new: [] }, base: await baseOf(t.repo, t.dir, 'f.txt') }, ctx);
    expect(await counts(t, 'f.txt')).toEqual([[0, 2], [0, 28]]);
    await stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false, selection: { kind: 'hunks', hunks: [0] }, base: await baseOf(t.repo, t.dir, 'f.txt') }, ctx);
    expect((await loadIndex(mainWt(t.repo))).some((e) => e.path === 'f.txt')).toBe(false);
  });

  it("a hunk never carries the file's mode", async () => {
    const { t, ctx } = await repo();
    await t.write('f.txt', thirty([3, 20]), { exec: true });
    await stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false, selection: { kind: 'hunks', hunks: [0] }, base: await baseOf(t.repo, t.dir, 'f.txt') }, ctx);
    expect((await loadIndex(mainWt(t.repo))).find((e) => e.path === 'f.txt')?.mode).toBe(MODE_FILE);
    await t.write('f.txt', thirty([]), { exec: true });
    await stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: true, selection: { kind: 'hunks', hunks: [0] }, base: await baseOf(t.repo, t.dir, 'f.txt') }, ctx);
    const base = await baseOf(t.repo, t.dir, 'f.txt');
    await expect(stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false, selection: { kind: 'hunks', hunks: [0] }, base }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "Only the file's mode changed: stage the whole file" });
  });

  it('refuses a stale base, a binary file and an empty selection', async () => {
    const { t, ctx } = await repo();
    const base = await baseOf(t.repo, t.dir, 'f.txt');
    await t.write('f.txt', thirty([3, 20, 25]));
    await expect(stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false, selection: { kind: 'hunks', hunks: [0] }, base }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'f.txt changed since it was shown' });
    await expect(stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'b.bin', staged: false, selection: { kind: 'hunks', hunks: [0] }, base: await baseOf(t.repo, t.dir, 'b.bin') }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Binary file: stage the whole file' });
    await expect(stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false, selection: { kind: 'hunks', hunks: [] }, base: await baseOf(t.repo, t.dir, 'f.txt') }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'No changed lines are selected' });
  });

  it("refuses a dirty submodule at its recorded commit (its Subproject commit lines), staging and discarding", async () => {
    const { t, ctx } = await repo();
    const head = await writeNested(t, 'sm', 'sm', { 's.txt': 's\n' });
    await setIndex(t, [...(await loadIndex(mainWt(t.repo))), { path: 'sm', mode: MODE_GITLINK, oid: head, stage: 0 }]);
    await t.write('sm/s.txt', 's2\n');
    const base = await baseOf(t.repo, t.dir, 'sm');
    const sel = { kind: 'hunks' as const, hunks: [0] };
    await expect(stageHandlers.stagePatch({ repo: 1, worktree: t.dir, path: 'sm', staged: false, selection: sel, base }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Submodule: stage the whole file' });
    await expect(discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'patch', path: 'sm', selection: sel, base } }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Submodule: discard the whole file' });
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
  });
});
