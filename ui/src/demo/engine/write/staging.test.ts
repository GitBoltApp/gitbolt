import { describe, expect, it } from 'vitest';
import { makeTestRepo, setIndex } from '../read/testkit';
import { MODE_FILE } from '../read/trees';
import { writeFileState } from './files';
import { entryOfFile, loadIndex, saveIndex, withEntry } from './index';
import { mainWt } from './seam';
import { capturePath, captureIndex, CONFLICTED_OFF, restorable, restoreCapture, restorePath, sameCapture, samePathState, sameTree, STAGING_CAP, StagingLog, stagingStateOf, type StagingStep } from './staging';

const enc = (s: string) => new TextEncoder().encode(s);
const step = (label: string, kind: 'tree' | 'resolve' = 'tree'): StagingStep => ({
  label,
  head: null,
  change: kind === 'tree' ? { kind, before: { entries: [], ita: [] }, after: { entries: [], ita: [] } } : { kind, path: 'p', before: { entries: [], disk: null }, after: { entries: [], disk: null }, op: null },
});

describe('the staging log', () => {
  it('keeps the last 100 steps, and a new step clears redo', () => {
    const log = new StagingLog();
    for (let n = 0; n < STAGING_CAP + 5; n++) log.record(step(`stage ${n}`));
    expect([log.undo.length, log.undo[0].label]).toEqual([STAGING_CAP, 'stage 5']);
    log.shift(true);
    expect(log.state(null)).toEqual({ undo: 'stage 103', redo: 'stage 104', off: null });
    log.record(step('unstage x'));
    expect(log.redo).toEqual([]);
  });

  it('says why it is off while files are conflicted, and keeps resolutions', () => {
    const log = new StagingLog();
    log.record(step('stage a'));
    expect(stagingStateOf(log, true)).toEqual({ undo: null, redo: null, off: CONFLICTED_OFF });
    log.record(step('resolve a.txt', 'resolve'));
    expect(stagingStateOf(log, true)).toEqual({ undo: 'resolve a.txt', redo: null, off: null });
  });

  it('captures and restores the index, intent-to-add entries included, and refuses while conflicted', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    const wt = mainWt(t.repo);
    const before = await captureIndex(wt);
    await t.write('a.txt', 'b\n');
    await t.write('ita.txt', 'later\n');
    const e = await entryOfFile(wt, 'a.txt');
    await saveIndex(wt, [...withEntry(await loadIndex(wt), 'a.txt', e), { path: 'ita.txt', mode: MODE_FILE, oid: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', stage: 0, intentToAdd: true }]);
    const after = await captureIndex(wt);
    expect(after?.ita).toEqual(['ita.txt']);
    expect(sameTree(before!, after!)).toBe(false);
    await restoreCapture(wt, before!);
    expect(sameCapture((await captureIndex(wt))!, before!)).toBe(true);
    await restoreCapture(wt, after!);
    expect(sameCapture((await captureIndex(wt))!, after!)).toBe(true);
    expect((await loadIndex(wt)).find((x) => x.path === 'ita.txt')?.intentToAdd).toBe(true);
    await setIndex(t, [{ path: 'a.txt', mode: MODE_FILE, oid: e!.oid, stage: 2 }]);
    expect(await captureIndex(wt)).toBeNull();
  });

  it("captures a path's stages and file, and puts them back", async () => {
    const t = await makeTestRepo();
    const wt = mainWt(t.repo);
    const A = '78981922613b2afb6025042ff6bd878ac1994e85';
    await setIndex(t, [{ path: 'c.txt', mode: MODE_FILE, oid: A, stage: 1 }, { path: 'c.txt', mode: MODE_FILE, oid: A, stage: 3 }]);
    writeFileState(wt, 'c.txt', { mode: MODE_FILE, bytes: enc('<<<<<<< HEAD\n') });
    const conflicted = await capturePath(wt, 'c.txt');
    expect(conflicted.entries.map((e) => e.stage)).toEqual([1, 3]);
    writeFileState(wt, 'c.txt', { mode: MODE_FILE, bytes: enc('resolved\n') });
    await saveIndex(wt, withEntry(await loadIndex(wt), 'c.txt', await entryOfFile(wt, 'c.txt')));
    const resolved = await capturePath(wt, 'c.txt');
    expect([samePathState(conflicted, resolved), restorable(conflicted, resolved)]).toEqual([false, true]);
    await restorePath(wt, 'c.txt', conflicted);
    expect(samePathState(await capturePath(wt, 'c.txt'), conflicted)).toBe(true);
  });
});
