import { describe, expect, it } from 'vitest';
import { Journal, MAX_ENTRIES, type JournalEntry, type NewEntry, type UndoKind } from './journal';
import type { Snapshot } from './snapshot';

const head = (oid: string, branch: string | null = 'main') => ({ branch, oid });
const entry = (label: string, undo: UndoKind = 'moveRefs'): NewEntry => ({ label, kind: 'commit', headBefore: head('a'), undo });
const snap = (paths: string[]): Snapshot => ({ paths, untracked: [], held: new Map(paths.map((p) => [p, { index: null, file: null, clean: false }])) });

/** Begins and finalizes one entry that moved `main`. */
function record(j: Journal, label: string, now = 1): number {
  const id = j.begin(entry(label), now);
  const e = j.entry(id)!;
  e.headAfter = head('b');
  e.refs = [{ name: 'refs/heads/main', old: 'a', new: 'b' }];
  j.finalize(id);
  return id;
}

function discard(j: Journal, paths: string[]): number {
  const id = j.begin({ label: `discard ${paths.join(', ')}`, kind: 'discard', headBefore: head('a'), undo: 'restore' }, 1);
  const e = j.entry(id)!;
  e.before = snap(paths);
  e.after = snap(paths);
  j.finalize(id);
  return id;
}

describe('the journal', () => {
  it('writes entries ahead, finalizes or drops them, and says what Undo and Redo do', () => {
    const j = new Journal();
    expect(j.state(null)).toEqual({ undo: null, redo: null, undoBlocked: 'Nothing to undo', redoBlocked: 'Nothing to redo', banners: [], paused: null });
    const id = j.begin(entry('commit "x"'), 5);
    expect(j.state(null).undo).toBeNull(); // pending isn't undoable
    expect(j.finalize(id)).toBe(false); // nothing changed: dropped
    expect(j.undo).toEqual([]);
    const a = record(j, 'commit "a"');
    expect(j.state(null).undo).toEqual({ entry: a, label: 'commit "a"', kind: 'commit' });
    j.shift(a, true);
    expect(j.state(null)).toMatchObject({ undo: null, redo: { entry: a }, undoBlocked: 'Nothing to undo', redoBlocked: null });
    record(j, 'commit "b"');
    expect(j.redo).toEqual([]); // a new operation clears redo
    expect(j.state('merge')).toMatchObject({ undoBlocked: 'Finish or abort the merge first', redoBlocked: 'Finish or abort the merge first' });
  });

  it('keeps the last 50, barriers block Undo, and kept stashes have banners', () => {
    const j = new Journal();
    for (let n = 0; n < MAX_ENTRIES + 3; n++) record(j, `commit "${n}"`);
    expect([j.undo.length, j.undo[0].label]).toEqual([MAX_ENTRIES, 'commit "3"']);
    const id = j.begin(entry('delete branch x'), 1);
    const bid = j.barrierBefore(id, 'delete origin/x', 'push', head('a'), 1)!;
    j.dropEntry(id);
    expect(j.undoTop()?.id).toBe(bid);
    expect(j.state(null).undoBlocked).toBe("Push can't be undone");
    const k = j.keep({ oid: 'f'.repeat(40), message: 'autostash before checkout x', label: 'checkout x', target: 'x', reason: { status: 'conflicts', files: 2, binary: true }, createdMs: 1 });
    j.keep({ oid: null, message: 'pending', label: 'checkout y', target: null, reason: { status: 'pending' }, createdMs: 1 });
    expect(j.state(null).banners).toEqual([{ entry: k, kind: 'autostashConflicts', label: 'checkout x', stash: 'f'.repeat(40), stashMessage: 'autostash before checkout x', target: 'x', snapshot: false, files: 2, canDrop: true, binary: true }]);
    expect(j.forgetKeptStash('f'.repeat(40))).toBe(true);
    expect(j.state(null).banners).toEqual([]);
  });

  it('pauses a merge, survives the cap, and settles it as done or gone', () => {
    const paused = (j: Journal, label: string) => {
      const id = j.begin({ label, kind: 'merge', headBefore: head('a'), undo: 'rewind' }, 1);
      const e = j.entry(id)!;
      e.state = 'paused';
      e.paused = { kind: 'merge', target: 'x', refsBefore: new Map([['refs/heads/main', 'a']]), autostash: null, targetOid: 'c', picked: [], irebase: null };
      return id;
    };
    const capped = new Journal();
    const id = paused(capped, 'merge x into main');
    for (let n = 0; n < MAX_ENTRIES + 2; n++) record(capped, `stage ${n}`);
    expect([capped.paused()?.id, capped.undo.length]).toEqual([id, MAX_ENTRIES]);
    expect(capped.state(null).paused).toEqual({ entry: id, kind: 'merge', label: 'merge x into main', target: 'x', irebase: false });
    const j = new Journal();
    const done = paused(j, 'merge x into main');
    expect(j.settle(done, head('m'), [{ name: 'refs/heads/main', old: 'a', new: 'm' }])).toBe(true);
    expect([j.paused(), j.entry(done)?.state]).toEqual([null, 'done']);
    const abort = paused(j, 'merge y into main');
    expect(j.settle(abort, head('a'), [])).toBe(false);
    expect(j.entry(abort)).toBeNull();
  });

  it('coalesces a save into the one below it', () => {
    const j = new Journal();
    const first = discard(j, ['a.txt']);
    const second = j.begin({ label: 'discard a.txt', kind: 'discard', headBefore: head('a'), undo: 'restore' }, 2);
    expect(j.below(second)?.id).toBe(first);
    j.entry(second)!.after = snap(['a.txt']);
    expect(j.coalesce(second, first)).toBe(true);
    expect(j.undo.map((e) => e.id)).toEqual([first]);
  });

  it('lists the dropdown newest first, with what each touched and why an older one is blocked', () => {
    const j = new Journal();
    const a = discard(j, ['a.txt']);
    const b = discard(j, ['b.txt']);
    const c = discard(j, ['a.txt']);
    const rows = j.history(null, null);
    expect(rows.map((r) => [r.entry, r.touched, r.blocked])).toEqual([
      [c, ['a.txt'], null],
      [b, ['b.txt'], null],
      [a, ['a.txt'], 'A later action changed a.txt'],
    ]);
    expect('entry' in j.outOfOrder(b, null)).toBe(true);
    expect(j.outOfOrder(a, null)).toEqual({ why: 'A later action changed a.txt' });
    const commit = record(j, 'commit "x"');
    const moved = j.history(null, null).find((r) => r.entry === commit)!;
    expect(moved.touched).toEqual(['working tree', 'main']);
    expect(j.outOfOrder(b, null)).toEqual({ why: 'A later action changed the working tree (commit "x")' });
    expect(j.outOfOrder(c, null)).toEqual({ why: 'A later action changed the working tree (commit "x")' });
    expect(j.history('rebase', 'Finish or abort the rebase first').map((r) => r.blocked)).toEqual(Array(4).fill('Finish or abort the rebase first'));
    const ref = j.begin(entry('create branch x'), 1);
    j.entry(ref)!.refs = [{ name: 'refs/heads/x', old: null, new: 'a' }];
    j.finalize(ref);
    const theRow = (rows2: ReturnType<Journal['history']>, id: number) => rows2.find((r) => r.entry === id)!;
    expect(theRow(j.history(null, null), commit).blocked).toBeNull();
    expect(j.redoSurvives(j.entry(b) as JournalEntry)).toBe(true);
  });
});
