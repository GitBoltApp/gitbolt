import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { demoOf, ig, readRepoOf } from './seam';
import { GRACE, fakeCtx, makeTestRepo } from './testkit';

describe('testkit', () => {
  it('commits what the worktree holds, 60 s apart, as the given author', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    await t.write('bin/run.sh', '#!/bin/sh\n', { exec: true });
    const first = await t.commit('First');
    await t.write('a.txt', 'two\n');
    await t.remove('bin/run.sh');
    const second = await t.commit('Second', GRACE);
    const c = await git.readCommit({ ...ig(t.repo), oid: second });
    expect(c.commit.parent).toEqual([first]);
    expect(c.commit.author.name).toBe('Grace Hopper');
    const before = await git.readCommit({ ...ig(t.repo), oid: first });
    expect(c.commit.committer.timestamp - before.commit.committer.timestamp).toBe(60);
    expect(await git.listFiles({ ...ig(t.repo), ref: second })).toEqual(['a.txt']);
    const tree = await git.readTree({ ...ig(t.repo), oid: first, filepath: 'bin' });
    expect(tree.tree[0].mode).toBe('100755');
  });

  it('opens it as a 1a DemoRepo whose store has every commit, and serves it through a fake context', async () => {
    const t = await makeTestRepo('basic');
    await t.write('a.txt', 'a\n');
    const head = await t.commit('Start');
    const ctx = fakeCtx(t.repo);
    expect(readRepoOf(ctx, 1)).toBe(t.repo);
    expect(t.repo.dir).toBe('/demo/basic');
    expect((await demoOf(t.repo).worktrees())[0]).toMatchObject({ path: '/demo/basic', head, branch: 'refs/heads/main', isMain: true });
    expect(demoOf(t.repo).commits.has(head)).toBe(true);
  });
});
