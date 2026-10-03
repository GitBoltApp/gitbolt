import { describe, expect, it } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import { isConflictTarget } from '../repo/LazyDiffPanel';
import { targetFor } from '../repo/store';
import { followTarget } from './follow';

const WT = '/r';
const change = (path: string, oid: string): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object', oid }, new: { kind: 'worktree', worktree: WT }, submodule: false });
const list = (...files: FileChange[]): FileListPayload => ({ files, added: 0, deleted: 0 });
const unstagedSpec = { kind: 'wip', worktree: WT, staged: false } as const;
const stagedSpec = { kind: 'wip', worktree: WT, staged: true } as const;

describe('the open diff follows the file (spec #2 §7.1)', () => {
  it('a whole file staged reopens from Staged', () => {
    const open = targetFor(change('a.txt', 'i1'), unstagedSpec);
    const next = followTarget(open, WT, { unstaged: list(), staged: list(change('a.txt', 'h1')) });
    expect(next?.key).toBe(targetFor(change('a.txt', 'h1'), stagedSpec).key);
  });

  it('a partially staged file keeps the section it was opened from, with its fresh sides', () => {
    const open = targetFor(change('a.txt', 'i1'), unstagedSpec);
    const next = followTarget(open, WT, { unstaged: list(change('a.txt', 'i2')), staged: list(change('a.txt', 'h1')) });
    expect(next?.key).toBe(open.key);
    expect(next?.old).toEqual({ kind: 'object', oid: 'i2' });
  });

  it('a file in neither list closes; another worktree’s or a commit’s diff is left alone', () => {
    const open = targetFor(change('a.txt', 'i1'), unstagedSpec);
    expect(followTarget(open, WT, { unstaged: list(), staged: list() })).toBeNull();
    const other = targetFor(change('a.txt', 'i1'), { kind: 'wip', worktree: '/other', staged: false });
    expect(followTarget(other, WT, { unstaged: list(), staged: list() })).toBe(other);
  });

  it('a resolution undone reopens the file as a conflict: the merge tool shows it again', () => {
    const open = targetFor(change('a.txt', 'h1'), stagedSpec);
    const conflicted = { ...change('a.txt', 'i1'), status: 'U' };
    const next = followTarget(open, WT, { unstaged: list(conflicted), staged: list() });
    expect(next && isConflictTarget(next)).toBe(true);
  });

  it('keeps the File View / Diff View choice', () => {
    const open = { ...targetFor(change('a.txt', 'i1'), unstagedSpec), view: 'file' as const };
    expect(followTarget(open, WT, { unstaged: list(), staged: list(change('a.txt', 'h1')) })?.view).toBe('file');
  });
});
