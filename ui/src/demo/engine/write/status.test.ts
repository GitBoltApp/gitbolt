import { describe, expect, it } from 'vitest';
import { makeTestRepo, setIndex } from '../read/testkit';
import { MODE_FILE } from '../read/trees';
import { loadIndex } from './index';
import { mainWt } from './seam';
import { dirty, statusEntries, summarize } from './status';

const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `line ${i}${tag}\n`).join('');

describe('status as the core reads porcelain v2', () => {
  it('letters each changed path, pairs staged renames, lists untracked files last', async () => {
    const t = await makeTestRepo();
    await t.write('mod.txt', 'a\n');
    await t.write('gone.txt', 'g\n');
    await t.write('staged.txt', 's\n');
    await t.write('old.txt', lines(20));
    await t.write('space name.txt', 'x\n');
    await t.commit('Base');
    await t.write('mod.txt', 'a2\n');
    await t.remove('gone.txt');
    await t.write('staged.txt', 's2\n');
    await t.stage('staged.txt');
    await t.remove('old.txt');
    await t.stage('old.txt');
    await t.write('new.txt', lines(20));
    await t.stage('new.txt');
    await t.write('untracked.txt', 'u\n');
    await t.write('space name.txt', 'y\n');
    const s = await statusEntries(t.repo, t.dir);
    expect(s.map((e) => [e.path, e.origPath, e.index + e.worktree, e.kind])).toEqual([
      ['gone.txt', null, '.D', 'ordinary'],
      ['mod.txt', null, '.M', 'ordinary'],
      ['new.txt', 'old.txt', 'R.', 'renamed'],
      ['space name.txt', null, '.M', 'ordinary'],
      ['staged.txt', null, 'M.', 'ordinary'],
      ['untracked.txt', null, '??', 'untracked'],
    ]);
    expect(summarize(s)).toEqual({ modified: 3, added: 1, deleted: 1, renamed: 1, conflicted: 0 });
    const d = await dirty(t.repo, t.dir);
    expect([...d.tracked].sort()).toEqual(['gone.txt', 'mod.txt', 'new.txt', 'old.txt', 'space name.txt', 'staged.txt']);
    expect([...d.untracked]).toEqual(['untracked.txt']);
  });

  it('counts conflicts with git letters, and intent-to-add as .A', async () => {
    const t = await makeTestRepo();
    await t.write('c.txt', 'base\n');
    await t.write('d.txt', 'base\n');
    await t.commit('Base');
    const base = (await loadIndex(mainWt(t.repo)))[0].oid;
    const A = 'a'.repeat(40);
    await t.write('ita.txt', 'later\n');
    await setIndex(t, [
      { path: 'c.txt', mode: MODE_FILE, oid: base, stage: 1 },
      { path: 'c.txt', mode: MODE_FILE, oid: A, stage: 2 },
      { path: 'c.txt', mode: MODE_FILE, oid: A, stage: 3 },
      { path: 'd.txt', mode: MODE_FILE, oid: base, stage: 1 },
      { path: 'd.txt', mode: MODE_FILE, oid: A, stage: 3 },
      { path: 'ita.txt', mode: MODE_FILE, oid: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', stage: 0, intentToAdd: true },
    ]);
    const s = await statusEntries(t.repo, t.dir);
    expect(s.map((e) => [e.path, e.index + e.worktree, e.kind])).toEqual([
      ['c.txt', 'UU', 'unmerged'],
      ['d.txt', 'DU', 'unmerged'],
      ['ita.txt', '.A', 'ordinary'],
    ]);
    expect(summarize(s)).toEqual({ modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 2 });
    const d = await dirty(t.repo, t.dir);
    expect([d.conflicted, d.unmerged]).toEqual([2, ['c.txt', 'd.txt']]);
  });

  it('a tracked file replaced by a folder is deleted, and the folder is untracked', async () => {
    const t = await makeTestRepo();
    await t.write('t.txt', 'x\n');
    await t.commit('Base');
    await t.remove('t.txt');
    await t.write('t.txt/f', 'y\n');
    const s = await statusEntries(t.repo, t.dir);
    expect(s.map((e) => [e.path, e.index + e.worktree])).toEqual([['t.txt', '.D'], ['t.txt/f', '??']]);
  });
});
