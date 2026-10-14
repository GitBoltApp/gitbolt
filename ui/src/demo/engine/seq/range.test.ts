import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { readCommit } from '../read/commitText';
import { addWorktree, makeTestRepo } from '../read/testkit';
import { branchesElsewhere, branchSets, isAncestor, rangeCommits } from './range';
import { irebaseShape, stackShape } from './fixtures';

describe('range', () => {
  // The order `git log --topo-order main..feature/c` gives on the core's irebase fixture (2.53).
  it('lists base..tip children first, the merged line before the first parent', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    const rows = await rangeCommits(t.repo, await t.rev('feature/c'), await t.rev('main'));
    const names = await Promise.all(rows.map(async (r) => (await readCommit(t.repo, r.oid)).summary));
    expect(names).toEqual(['C2 Polish', 'C1 Edit notes again', 'B2 Refine lexer', 'Merge side', 'S1 Side work', 'B1 Add lexer', 'A3 Add tests', 'A2 Edit notes', 'A1 Add parser']);
  });

  it('splits the branches in range into stacked and merged-in', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    const sets = await branchSets(t.repo, 'refs/heads/feature/c', await t.rev('feature/c'), await t.rev('main'));
    expect(sets.stacked.map(([n]) => n)).toEqual(['refs/heads/feature/a', 'refs/heads/feature/b']);
    expect(sets.mergedIn.map(([n]) => n)).toEqual(['refs/heads/side']);
    await git.deleteRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/side' });
    expect((await branchSets(t.repo, 'refs/heads/feature/c', await t.rev('feature/c'), await t.rev('main'))).mergedIn).toEqual([]);
  });

  it('knows ancestry', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    expect(await isAncestor(t.repo, await t.rev('feature/a'), await t.rev('feature/c'))).toBe(true);
    expect(await isAncestor(t.repo, await t.rev('main'), await t.rev('feature/c'))).toBe(false);
  });

  it('names the branches checked out in other worktrees', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const path = await addWorktree(t, 'a', 'feature/a');
    expect([...(await branchesElsewhere(t.repo, t.dir))]).toEqual([['refs/heads/feature/a', path]]);
    expect([...(await branchesElsewhere(t.repo, path))]).toEqual([['refs/heads/feature/c', t.dir]]);
  });
});
