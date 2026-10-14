import { describe, expect, it } from 'vitest';
import { makeTestRepo, setIndex } from '../read/testkit';
import { MODE_EXEC, MODE_FILE } from '../read/trees';
import { readFileState, writeFileState } from './files';
import { entryOfFile, loadIndex, saveIndex, stage0Of, withEntry } from './index';
import { EMPTY_BLOB } from './objects';
import { mainWt } from './seam';
import { changedSince, createSnapshot, restoreSnapshot, restoreSnapshotIndex, sameSnapshot } from './snapshot';

const enc = (s: string) => new TextEncoder().encode(s);

async function dirtyRepo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  await t.write('run.sh', 'run\n');
  await t.write('dir/x.txt', 'x\n');
  await t.write('dir/y.txt', 'y\n');
  await t.commit('Base');
  await t.write('a.txt', 'a staged\n');
  await t.stage('a.txt');
  await t.write('a.txt', 'a unstaged\n');
  await t.write('run.sh', 'run\n', { exec: true });
  await t.write('dir/x.txt', 'x2\n');
  await t.write('new.txt', 'new\n');
  return { t, wt: mainWt(t.repo) };
}

describe('snapshots', () => {
  it('lists the untracked paths first, then the others, a tracked folder as its files', async () => {
    const { wt } = await dirtyRepo();
    const s = await createSnapshot(wt, ['a.txt', 'dir', 'new.txt', 'run.sh'], ['new.txt']);
    expect([s.paths, s.untracked]).toEqual([['new.txt', 'a.txt', 'dir/x.txt', 'dir/y.txt', 'run.sh'], ['new.txt']]);
    expect(s.held.get('new.txt')).toEqual({ index: null, file: { mode: MODE_FILE, bytes: enc('new\n') }, clean: false });
    expect(s.held.get('dir/y.txt')?.clean).toBe(true);
    expect(s.held.get('run.sh')?.file?.mode).toBe(MODE_EXEC);
  });

  it('restores both halves of every path byte for byte, and deletes what the snapshot had no file for', async () => {
    const { wt } = await dirtyRepo();
    const before = await createSnapshot(wt, ['a.txt', 'dir', 'new.txt', 'run.sh'], ['new.txt']);
    const indexBefore = stage0Of(await loadIndex(wt));
    // A Discard all's effect: every tracked path back to HEAD, the untracked file deleted.
    writeFileState(wt, 'new.txt', null);
    writeFileState(wt, 'a.txt', { mode: MODE_FILE, bytes: enc('a\n') });
    writeFileState(wt, 'run.sh', { mode: MODE_FILE, bytes: enc('run\n') });
    writeFileState(wt, 'dir/x.txt', { mode: MODE_FILE, bytes: enc('x\n') });
    await saveIndex(wt, withEntry(await loadIndex(wt), 'a.txt', await entryOfFile(wt, 'a.txt')));
    expect(await changedSince(wt, before)).toEqual(['new.txt', 'a.txt', 'dir/x.txt', 'run.sh']);
    const after = await createSnapshot(wt, before.paths, before.untracked);
    expect(sameSnapshot(before, after)).toBe(false);
    await restoreSnapshot(wt, before);
    expect(readFileState(wt, 'new.txt')?.bytes).toEqual(enc('new\n'));
    expect(readFileState(wt, 'a.txt')?.bytes).toEqual(enc('a unstaged\n'));
    expect(readFileState(wt, 'run.sh')?.mode).toBe(MODE_EXEC);
    expect(readFileState(wt, 'dir/x.txt')?.bytes).toEqual(enc('x2\n'));
    expect(stage0Of(await loadIndex(wt)).get('a.txt')?.oid).toBe(indexBefore.get('a.txt')?.oid);
    expect(await changedSince(wt, before)).toEqual([]);
    await restoreSnapshot(wt, after);
    expect(readFileState(wt, 'new.txt')).toBeNull();
    expect(sameSnapshot(after, await createSnapshot(wt, after.paths, after.untracked))).toBe(true);
  });

  it('restores only the index for a mixed reset, and refuses a conflicted path', async () => {
    const { t, wt } = await dirtyRepo();
    const snap = await createSnapshot(wt, ['a.txt'], []);
    await saveIndex(wt, withEntry(await loadIndex(wt), 'a.txt', null));
    await restoreSnapshotIndex(wt, snap);
    expect(stage0Of(await loadIndex(wt)).get('a.txt')?.oid).toBe(snap.held.get('a.txt')?.index?.oid);
    expect(readFileState(wt, 'a.txt')?.bytes).toEqual(enc('a unstaged\n'));
    const A = 'a'.repeat(40);
    await setIndex(t, [{ path: 'a.txt', mode: MODE_FILE, oid: A, stage: 2 }, { path: 'a.txt', mode: MODE_FILE, oid: A, stage: 3 }]);
    await expect(createSnapshot(wt, ['a.txt'], [])).rejects.toMatchObject({ kind: 'InProgress', message: 'a.txt has merge conflicts: resolve conflicts first' });
  });

  it('holds an intent-to-add path as untracked, and refuses a folder in a file\'s way before writing anything', async () => {
    const { wt } = await dirtyRepo();
    await saveIndex(wt, [...(await loadIndex(wt)), { path: 'new.txt', mode: MODE_FILE, oid: EMPTY_BLOB, stage: 0, intentToAdd: true }]);
    const snap = await createSnapshot(wt, ['new.txt', 'a.txt'], []);
    expect(snap.held.get('new.txt')?.index).toBeNull();
    writeFileState(wt, 'new.txt', null);
    await saveIndex(wt, (await loadIndex(wt)).filter((e) => e.path !== 'new.txt'));
    await restoreSnapshot(wt, snap);
    expect(readFileState(wt, 'new.txt')?.bytes).toEqual(enc('new\n'));
    expect((await loadIndex(wt)).some((e) => e.path === 'new.txt')).toBe(false);
    writeFileState(wt, 'a.txt', null);
    writeFileState(wt, 'new.txt', null);
    writeFileState(wt, 'a.txt/inner', { mode: MODE_FILE, bytes: enc('i') });
    await expect(restoreSnapshot(wt, snap)).rejects.toMatchObject({ kind: 'DirtyWorktree', message: 'a.txt is a folder with files in it' });
    expect(readFileState(wt, 'new.txt')).toBeNull();
  });
});
