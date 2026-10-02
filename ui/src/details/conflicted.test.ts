import { describe, expect, it } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import { CONFLICT_TEXT, splitConflicted } from './conflicted';

const f = (path: string, status: string, extra: Partial<FileChange> = {}): FileChange => ({ path, oldPath: null, status, additions: 1, deletions: 1, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false, ...extra });
const list = (...files: FileChange[]) => ({ files, added: files.length, deleted: files.length });

describe('the Conflicted section (spec #2 §7.1)', () => {
  it('takes the conflicted files out of both other lists, totals recounted', () => {
    const out = splitConflicted(list(f('c.txt', 'U', { conflict: 'bothModified' }), f('a.txt', 'M')), list(f('c.txt', 'U'), f('b.txt', 'A')));
    expect(out.conflicted.files.map((x) => x.path)).toEqual(['c.txt']);
    expect(out.unstaged.files.map((x) => x.path)).toEqual(['a.txt']);
    expect(out.staged.files.map((x) => x.path)).toEqual(['b.txt']);
    expect(out.unstaged.added).toBe(1);
  });

  it('names each kind for its row', () => {
    expect(CONFLICT_TEXT.bothModified).toBe('both modified');
    expect(CONFLICT_TEXT.deletedByThem).toBe('deleted by them');
  });
});
