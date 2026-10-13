import { describe, expect, it } from 'vitest';
import { revParse } from './revs';
import { listWorktrees, worktreeOf, worktreeRoot } from './worktrees';
import { addWorktree, makeTestRepo } from './testkit';

describe('worktrees', () => {
  it('a linked worktree has its own HEAD', async () => {
    const t = await makeTestRepo('basic');
    await t.write('a.txt', 'a\n');
    const base = await t.commit('Base');
    await t.branch('hotfix');
    await t.write('a.txt', 'main\n');
    const tip = await t.commit('Main moves');
    const path = await addWorktree(t, 'hotfix', 'hotfix');
    const list = await listWorktrees(t.repo);
    expect(list.map((w) => [w.path, w.isMain, w.branch, w.head])).toEqual([
      ['/demo/basic', true, 'refs/heads/main', tip],
      [path, false, 'refs/heads/hotfix', base],
    ]);
    expect(await worktreeRoot(t.repo, `${path}/`)).toBe(path);
    expect(await revParse(t.repo, 'HEAD', path)).toBe(base);
    expect(await revParse(t.repo, 'HEAD')).toBe(tip);
    expect(path).toBe('/demo/.extra/basic/wt-hotfix');
    expect((await worktreeOf(t.repo, path)).gitdir).toBe('/demo/basic/.git/worktrees/hotfix');
    await expect(revParse(t.repo, 'HEAD', '/demo/other')).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(worktreeRoot(t.repo, '/demo/other')).rejects.toMatchObject({ kind: 'InvalidInput', message: '/demo/other is not a worktree of this repository' });
  });
});
