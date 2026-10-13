import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { integrateHandlers } from './integrate';
import { igNoCache } from '../engine/read/seam';
import { addWorktree, fakeCtx, makeTestRepo } from '../engine/read/testkit';

describe('integrate preview', () => {
  it('counts both sides, predicts conflicts and lists the stacked branches', async () => {
    const t = await makeTestRepo();
    await t.write('c.txt', 'base\n');
    const base = await t.commit('Base');
    await t.write('c.txt', 'main\n');
    await t.commit('Main');
    await t.branch('feature/a', base);
    await t.checkout('feature/a');
    await t.write('a.txt', 'a\n');
    const a1 = await t.commit('A1');
    await t.branch('feature/b', a1);
    await t.checkout('feature/b');
    await t.write('c.txt', 'b\n');
    await t.commit('B1');
    await addWorktree(t, 'a', 'feature/a');
    const ctx = fakeCtx(t.repo);
    const rebase = await integrateHandlers.integratePreview({ repo: 1, worktree: t.dir, kind: 'rebase', target: 'main' }, ctx);
    expect(rebase).toEqual({ ahead: 2, behind: 1, merged: false, conflicts: ['c.txt'], stacked: [{ name: 'feature/a', worktree: '/demo/.extra/test/wt-a' }], updateRefsDefault: true, lossyMerge: null });
    const merge = await integrateHandlers.integratePreview({ repo: 1, worktree: t.dir, kind: 'merge', target: 'feature/a' }, ctx);
    expect(merge).toMatchObject({ ahead: 1, behind: 0, merged: true, conflicts: [], stacked: [] });
    await git.setConfig({ ...igNoCache(t.repo), path: 'rebase.updateRefs', value: 'false' });
    expect((await integrateHandlers.integratePreview({ repo: 1, worktree: t.dir, kind: 'rebase', target: 'main' }, ctx)).updateRefsDefault).toBe(false);
    await expect(integrateHandlers.integratePreview({ repo: 1, worktree: t.dir, kind: 'merge', target: 'nope' }, ctx)).rejects.toMatchObject({ kind: 'NotFound' });
  });

  it('stacks only first-parent tips, none when detached, and refuses an unborn HEAD', async () => {
    const t = await makeTestRepo();
    await t.write('f.txt', 'base\n');
    const base = await t.commit('Base');
    await t.write('m.txt', 'main\n');
    await t.commit('Main');
    await t.branch('side', base);
    await t.checkout('side');
    await t.write('s.txt', 's\n');
    const side = await t.commit('Side');
    await t.branch('feature/a', base);
    await t.checkout('feature/a');
    await t.write('a.txt', 'a\n');
    const a1 = await t.commit('A1');
    await t.write('s.txt', 's\n');
    await t.commit('Merge side', undefined, { parents: [a1, side] });
    await t.branch('at-merge');
    await t.branch('old-main', base);
    const ctx = fakeCtx(t.repo);
    const rebase = await integrateHandlers.integratePreview({ repo: 1, worktree: t.dir, kind: 'rebase', target: 'main' }, ctx);
    expect(rebase.stacked).toEqual([{ name: 'at-merge', worktree: null }]);
    expect(rebase).toMatchObject({ ahead: 3, behind: 1, conflicts: [] });
    await git.checkout({ ...igNoCache(t.repo), dir: t.dir, ref: a1, force: true });
    expect(await integrateHandlers.integratePreview({ repo: 1, worktree: t.dir, kind: 'rebase', target: 'main' }, ctx)).toMatchObject({ ahead: 1, stacked: [] });

    const unborn = await makeTestRepo('unborn');
    await expect(integrateHandlers.integratePreview({ repo: 1, worktree: unborn.dir, kind: 'merge', target: 'main' }, fakeCtx(unborn.repo))).rejects.toMatchObject({
      kind: 'Other',
      message: "Branch 'refs/heads/main' does not have any commits",
    });
  });
});
