import { describe, expect, it, vi } from 'vitest';
vi.mock('../api/client', () => ({ api: {} }));
import type { DiffTarget } from '../repo/store';
import type { FileTarget } from '../menu/menuEnv';
import { historyStart, restoreSource } from './sources';

const A = 'a'.repeat(40), P = 'p'.repeat(40), F = 'f'.repeat(40), T = 't'.repeat(40);
const key = (spec: object, path: string) => `${JSON.stringify(spec)}|${path}`;
const target = (spec: object, over: Partial<DiffTarget> = {}, t: Partial<FileTarget> = {}): FileTarget => {
  const diff: DiffTarget = { key: key(spec, 'src/a.txt'), path: 'src/a.txt', oldPath: null, status: 'M', old: { kind: 'object', oid: 'o'.repeat(40) }, new: { kind: 'object', oid: 'n'.repeat(40) }, view: 'diff', ...over };
  return { path: diff.path, root: '/r', sha: A, upstream: null, diff, changed: true, deleted: diff.new.kind === 'absent', list: (spec as { kind: FileTarget['list'] }).kind, wip: null, openIn: { worktree: '/r', path: diff.path, line: null, source: null, fallback: null }, ...t };
};

describe('where History starts and what Restore takes (rulings 1, 4)', () => {
  it('a commit\'s file: its history as of that commit; restore from it', () => {
    const t = target({ kind: 'commit', id: A, parent: 0 });
    expect(historyStart(t)).toEqual({ path: 'src/a.txt', rev: A });
    expect(restoreSource(t)).toEqual({ sha: A, absent: false });
  });

  it('a file the commit deleted: history from the parent; restoring from the commit deletes it', () => {
    const t = target({ kind: 'commit', id: A, parent: 0 }, { status: 'D', new: { kind: 'absent' } }, { sha: P });
    expect(historyStart(t)).toEqual({ path: 'src/a.txt', rev: P });
    expect(restoreSource(t)).toEqual({ sha: A, absent: true });
  });

  it('a compare restores from TO; one with the working tree from FROM, never a rename there', () => {
    expect(restoreSource(target({ kind: 'compare', from: F, to: T }))).toEqual({ sha: T, absent: false });
    const wt = { kind: 'worktree', from: F, worktree: '/r' };
    expect(restoreSource(target(wt, { new: { kind: 'worktree', worktree: '/r' } }, { sha: null }))).toEqual({ sha: F, absent: false });
    expect(restoreSource(target(wt, { old: { kind: 'absent' }, status: 'A', new: { kind: 'worktree', worktree: '/r' } }, { sha: null }))).toEqual({ sha: F, absent: true });
    expect(restoreSource(target(wt, { status: 'R', oldPath: 'a.txt' }, { sha: null }))).toBeNull();
  });

  it('"View all files" restores from its commit', () => {
    expect(restoreSource(target({ kind: 'commit', id: A, parent: 0 }, { new: { kind: 'atCommit', commit: A }, status: '' }))).toEqual({ sha: A, absent: false });
  });

  it('a WIP file: history from its worktree\'s HEAD (a rename\'s old path); none for a new file; never a restore', () => {
    const spec = { kind: 'wip', worktree: '/wt', staged: false };
    const wip = (status: string, oldPath: string | null = null) => target(spec, { status }, { sha: null, wip: { worktree: '/wt', staged: false, oldPath, status } });
    expect(historyStart(wip('M'))).toEqual({ path: 'src/a.txt', rev: null, worktree: '/wt' });
    expect(historyStart(wip('R', 'old.txt'))).toEqual({ path: 'old.txt', rev: null, worktree: '/wt' });
    expect(historyStart(wip('A'))).toBeNull();
    expect(restoreSource(wip('M'))).toBeNull();
  });
});
