import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { makeTestRepo, setIndex } from '../read/testkit';
import { MODE_EXEC, MODE_FILE } from '../read/trees';
import { entryOfFile, keepStat, loadIndex, saveIndex, stage0Of, statOf, unmergedOf, withEntry } from './index';
import { mainWt } from './seam';

const B_BLOB = '61780798228d17af2d34fce4cfbdf35556832472'; // "b\n"

describe('the index for writes', () => {
  it('stages a file with its blob, mode and full stat data, which isomorphic-git trusts', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.write('run.sh', 'run\n', { exec: true });
    await t.commit('Base');
    const wt = mainWt(t.repo);
    await t.write('a.txt', 'b\n');
    const e = await entryOfFile(wt, 'a.txt');
    expect(e).toMatchObject({ path: 'a.txt', mode: MODE_FILE, stage: 0, oid: B_BLOB });
    expect(e?.stat).toEqual(statOf(wt, 'a.txt'));
    expect(e?.stat?.ctimeS).toBe(Math.floor(t.memfs.lstatSync(`${t.dir}/a.txt`).ctimeMs / 1000));
    await saveIndex(wt, withEntry(await loadIndex(wt), 'a.txt', e));
    expect(await git.statusMatrix({ fs: t.memfs, dir: t.dir })).toEqual([['a.txt', 1, 2, 2], ['run.sh', 1, 1, 1]]);
    expect((await loadIndex(wt)).find((x) => x.path === 'run.sh')?.mode).toBe(MODE_EXEC);
    expect(await entryOfFile(wt, 'gone.txt')).toBeNull();
  });

  it('keeps conflict stages and intent-to-add entries through a save, sorted', async () => {
    const t = await makeTestRepo();
    const wt = mainWt(t.repo);
    const A = 'a'.repeat(40);
    await setIndex(t, [
      { path: 'z.txt', mode: MODE_FILE, oid: A, stage: 0, intentToAdd: true },
      { path: 'c.txt', mode: MODE_FILE, oid: A, stage: 3 },
      { path: 'c.txt', mode: MODE_FILE, oid: A, stage: 1 },
    ]);
    const entries = await loadIndex(wt);
    await saveIndex(wt, entries.reverse());
    const back = await loadIndex(wt);
    expect(back.map((e) => [e.path, e.stage, e.intentToAdd ?? false])).toEqual([['c.txt', 1, false], ['c.txt', 3, false], ['z.txt', 0, true]]);
    expect([...unmergedOf(back).keys()]).toEqual(['c.txt']);
    expect([...stage0Of(back).keys()]).toEqual(['z.txt']);
    expect(withEntry(back, 'c.txt', null).map((e) => e.path)).toEqual(['z.txt']);
  });

  it('carries stat data over to an entry that names the same blob and mode', () => {
    const stat = { mtimeS: 1, mtimeNs: 2, ino: 3, size: 4 };
    const now = new Map([['a', { path: 'a', mode: MODE_FILE, oid: B_BLOB, stage: 0, stat }]]);
    expect(keepStat(now, { path: 'a', mode: MODE_FILE, oid: B_BLOB, stage: 0 }).stat).toBe(stat);
    expect(keepStat(now, { path: 'a', mode: MODE_EXEC, oid: B_BLOB, stage: 0 }).stat).toBeUndefined();
  });
});
