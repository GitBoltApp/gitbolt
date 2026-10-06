import { describe, expect, it } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import { changesTarget, needsFileList } from './changes';
import { row } from './testRows';

const P = 'p'.repeat(40);
const Q = 'q'.repeat(40);
const at = (commit: string) => ({ kind: 'atCommit', commit });
const change = (f: Partial<FileChange>): FileChange => ({ path: 'src/story.txt', oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object', oid: 'o1' }, new: { kind: 'object', oid: 'n1' }, submodule: false, ...f });

describe('File History Changes: the sides', () => {
  it('a change: the commit against its parent, at the same path', () => {
    const r = { ...row('c1'), parents: [P] };
    expect(needsFileList(r)).toBe(false);
    expect(changesTarget(r)).toMatchObject({ path: 'src/story.txt', oldPath: null, status: 'M', old: at(P), new: at('c1'), view: 'diff', sides: { old: P, new: 'c1' } });
  });

  it('an add is all added: no old side, even with a parent', () => {
    expect(changesTarget({ ...row('c1', 'A'), parents: [P] })).toMatchObject({ status: 'A', old: { kind: 'absent' }, new: at('c1'), sides: { old: null, new: 'c1' } });
    // The root commit.
    expect(changesTarget(row('c1', 'A'))).toMatchObject({ old: { kind: 'absent' }, new: at('c1') });
  });

  it('a delete is the deletion: the parent\'s file against nothing', () => {
    expect(changesTarget({ ...row('d1', 'D'), parents: [P] })).toMatchObject({ status: 'D', old: at(P), new: { kind: 'absent' }, sides: { old: P, new: null } });
  });

  it('a rename: the commit\'s own entry, its old side at the old path (Diff View\'s target)', () => {
    const r = { ...row('r1', 'R'), parents: [P], oldPath: 'story.txt' };
    expect(needsFileList(r)).toBe(true);
    // Its commit's file list still loading.
    expect(changesTarget(r, undefined)).toBeNull();
    const entry = change({ status: 'R', oldPath: 'story.txt' });
    const t = changesTarget(r, [change({ path: 'other.txt' }), entry]);
    expect(t).toMatchObject({ key: `${JSON.stringify({ kind: 'commit', id: 'r1', parent: 0 })}|src/story.txt`, path: 'src/story.txt', oldPath: 'story.txt', status: 'R', old: entry.old, new: entry.new, view: 'diff', sides: { old: P, new: 'r1' } });
    // No entry (the commit's own diff didn't pair them, or its list failed): shown as added.
    expect(changesTarget(r, null)).toMatchObject({ old: { kind: 'absent' }, new: at('r1'), sides: { old: null } });
  });

  it('a merge: against its first parent, as Diff View shows a commit', () => {
    const r = { ...row('m1', ''), parents: [P, Q] };
    expect(needsFileList(r)).toBe(true);
    // The file as the merge changed it against its first parent: that list's entry.
    const entry = change({});
    expect(changesTarget(r, [entry])).toMatchObject({ old: entry.old, new: entry.new, status: 'M', sides: { old: P, new: 'm1' } });
    // Not in that list (the first parent had it as is): both sides at the path, the first parent's old.
    expect(changesTarget(r, [])).toMatchObject({ status: 'M', old: at(P), new: at('m1') });
  });
});
