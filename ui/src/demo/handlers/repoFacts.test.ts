import { describe, expect, it } from 'vitest';
import { LFS_VERSION, repoFactsHandlers } from './repoFacts';
import { MODE_GITLINK } from '../engine/read/trees';
import { readIndex } from '../engine/read/indexFile';
import { fakeCtx, makeTestRepo, setIndex, writeNested } from '../engine/read/testkit';

describe('repository facts', () => {
  it('reports each submodule\'s state, and refuses an unmapped gitlink', async () => {
    const t = await makeTestRepo();
    await t.write('.gitmodules', '[submodule "parser"]\n\tpath = libs/parser\n[submodule "theme"]\n\tpath = libs/theme\n');
    const base = await t.commit('Base');
    const head = await writeNested(t, 'libs/parser', 'parser', { 'p.txt': 'p\n' });
    const entries = await readIndex(t.repo, t.repo.gitdir);
    await setIndex(t, [...entries, { path: 'libs/parser', mode: MODE_GITLINK, oid: base, stage: 0 }, { path: 'libs/theme', mode: MODE_GITLINK, oid: base, stage: 0 }]);
    const ctx = fakeCtx(t.repo);
    expect(await repoFactsHandlers.submodules({ repo: 1, worktree: t.dir }, ctx)).toEqual([
      { path: 'libs/parser', commit: head, status: 'newCommits' },
      { path: 'libs/theme', commit: base, status: 'uninitialized' },
    ]);
    await setIndex(t, [...entries, { path: 'vendor/x', mode: MODE_GITLINK, oid: base, stage: 0 }]);
    await expect(repoFactsHandlers.submodules({ repo: 1, worktree: t.dir }, ctx)).rejects.toMatchObject({ kind: 'Other', message: "fatal: no submodule mapping found in .gitmodules for path 'vendor/x'" });
  });

  it('reports LFS use, its patterns and the tracked paths', async () => {
    const t = await makeTestRepo();
    await t.write('README.md', 'r\n');
    await t.commit('Plain');
    const ctx = fakeCtx(t.repo);
    expect(await repoFactsHandlers.lfsStatus({ repo: 1 }, ctx)).toEqual({ used: false, version: LFS_VERSION, installUrl: 'https://git-lfs.com', patterns: [], filter: false });
    await t.write('.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n*.psd filter=lfs diff=lfs merge=lfs -text\n');
    await t.commit('Track art');
    expect(await repoFactsHandlers.lfsStatus({ repo: 1 }, ctx)).toMatchObject({ used: true, patterns: ['*.png', '*.psd'] });
    expect(await repoFactsHandlers.lfsTracked({ repo: 1, worktree: t.dir, paths: ['art/layers.psd', 'README.md', 'art/cover.png'] }, ctx)).toEqual(['art/layers.psd', 'art/cover.png']);
    expect(await repoFactsHandlers.lfsTracked({ repo: 1, worktree: t.dir, paths: [] }, ctx)).toEqual([]);
  });

  it('reports current and conflicted submodules', async () => {
    const t = await makeTestRepo();
    await t.write('.gitmodules', '[submodule "parser"]\n\tpath = libs/parser\n[submodule "theme"]\n\tpath = libs/theme\n');
    const base = await t.commit('Base');
    const head = await writeNested(t, 'libs/parser', 'parser', { 'p.txt': 'p\n' });
    const entries = await readIndex(t.repo, t.repo.gitdir);
    await setIndex(t, [...entries, { path: 'libs/parser', mode: MODE_GITLINK, oid: head, stage: 0 }, { path: 'libs/theme', mode: MODE_GITLINK, oid: base, stage: 1 }, { path: 'libs/theme', mode: MODE_GITLINK, oid: head, stage: 2 }]);
    expect(await repoFactsHandlers.submodules({ repo: 1, worktree: t.dir }, fakeCtx(t.repo))).toEqual([
      { path: 'libs/parser', commit: head, status: 'current' },
      { path: 'libs/theme', commit: '0'.repeat(40), status: 'conflicted' },
    ]);
  });

  it('refuses a directory that is not a worktree and unsafe LFS paths', async () => {
    const t = await makeTestRepo();
    await t.write('README.md', 'r\n');
    await t.commit('Plain');
    const ctx = fakeCtx(t.repo);
    await expect(repoFactsHandlers.submodules({ repo: 1, worktree: '/nowhere' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(repoFactsHandlers.lfsTracked({ repo: 1, worktree: '/nowhere', paths: ['a'] }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(repoFactsHandlers.lfsTracked({ repo: 1, worktree: t.dir, paths: ['../x'] }, ctx)).rejects.toBeTruthy();
  });
});
