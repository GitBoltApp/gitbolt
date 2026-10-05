import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import { isConflictTarget } from '../repo/LazyDiffPanel';
import { targetFor } from '../repo/store';
import { wipKey } from '../repo/wipLists';
import { useFileListPrefs } from '../files/fileListPrefs';

const view = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../app/tabStores', () => ({ tabView: () => view.current }));

import { advanceFrom, advanceTarget, followOpenFile, followTarget } from './follow';

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

describe('after a whole-file write the view moves to the next file', () => {
  const U = (...p: string[]) => list(...p.map((x) => change(x, 'i')));
  const S = (...p: string[]) => list(...p.map((x) => change(x, 'h')));
  const peeks = (unstaged: FileListPayload, staged: FileListPayload) => ({ [wipKey(WT, false)]: unstaged, [wipKey(WT, true)]: staged }) as Record<string, FileListPayload>;
  /** A tab showing `open` of `from`'s lists; `follow` runs after the write's `after` lists are in. */
  function run(open: ReturnType<typeof targetFor>, before: Record<string, FileListPayload>, after: Record<string, FileListPayload>, act: 'stage' | 'partial' = 'stage') {
    let lists = before;
    const state: { diff: typeof open | null; openFile: ReturnType<typeof vi.fn>; closeDiffTo: ReturnType<typeof vi.fn>; sections: unknown[] } = { diff: open, openFile: vi.fn((t) => { state.diff = t; }), closeDiffTo: vi.fn(() => { state.diff = null; }), sections: [] };
    view.current = { store: { getState: () => state }, services: { wip: { peek: (k: string) => lists[k] } } };
    const from = act === 'stage' ? advanceFrom('t', WT) : null;
    lists = after;
    followOpenFile('t', WT, from);
    return state;
  }
  beforeEach(() => { useFileListPrefs.setState({ mode: 'path', sort: 'path', advanceAfterStage: true }); });
  const at = (p: string, staged = false) => targetFor(change(p, staged ? 'h' : 'i'), staged ? stagedSpec : unstagedSpec);

  it('staging the open file shows the next unstaged one', () => {
    const st = run(at('b.txt'), peeks(U('a.txt', 'b.txt', 'c.txt'), S()), peeks(U('a.txt', 'c.txt'), S('b.txt')));
    expect(st.diff?.key).toBe(at('c.txt').key);
  });

  it('the last one shows the previous', () => {
    const st = run(at('c.txt'), peeks(U('a.txt', 'b.txt', 'c.txt'), S()), peeks(U('a.txt', 'b.txt'), S('c.txt')));
    expect(st.diff?.key).toBe(at('b.txt').key);
  });

  it('the only one keeps showing it, in Staged', () => {
    const st = run(at('a.txt'), peeks(U('a.txt'), S()), peeks(U(), S('a.txt')));
    expect(st.diff?.key).toBe(at('a.txt', true).key);
  });

  it('unstaging the open staged file: the same rules in the Staged section', () => {
    expect(run(at('a.txt', true), peeks(U(), S('a.txt', 'b.txt')), peeks(U('a.txt'), S('b.txt'))).diff?.key).toBe(at('b.txt', true).key);
    expect(run(at('b.txt', true), peeks(U(), S('a.txt', 'b.txt')), peeks(U('b.txt'), S('a.txt'))).diff?.key).toBe(at('a.txt', true).key);
    expect(run(at('a.txt', true), peeks(U(), S('a.txt')), peeks(U('a.txt'), S())).diff?.key).toBe(at('a.txt').key);
  });

  it('discarding the open file advances; the last one goes to the other section, or closes', () => {
    expect(run(at('a.txt'), peeks(U('a.txt', 'b.txt'), S()), peeks(U('b.txt'), S())).diff?.key).toBe(at('b.txt').key);
    expect(run(at('a.txt'), peeks(U('a.txt'), S('z.txt')), peeks(U(), S('z.txt'))).diff?.key).toBe(at('z.txt', true).key);
    expect(run(at('a.txt'), peeks(U('a.txt'), S()), peeks(U(), S())).closeDiffTo).toHaveBeenCalledWith('files');
  });

  it('a hunk staged (the file stays in its section) does not advance', () => {
    const st = run(at('a.txt'), peeks(U('a.txt', 'b.txt'), S()), peeks(U('a.txt', 'b.txt'), S('a.txt')));
    expect(st.diff?.key).toBe(at('a.txt').key);
  });

  it('staging a different file leaves the open one alone', () => {
    const st = run(at('a.txt'), peeks(U('a.txt', 'b.txt'), S()), peeks(U('a.txt'), S('b.txt')));
    expect(st.diff?.key).toBe(at('a.txt').key);
  });

  it('Tree mode follows the visual order', () => {
    useFileListPrefs.setState({ mode: 'tree' });
    // Tree order: d/x.txt before z.txt is shown first, folders before files: z.txt is last, d/y.txt is before it.
    const st = run(at('d/x.txt'), peeks(U('z.txt', 'd/x.txt', 'd/y.txt'), S()), peeks(U('z.txt', 'd/y.txt'), S('d/x.txt')));
    expect(st.diff?.key).toBe(at('d/y.txt').key);
  });

  it('with the setting off the file is followed into Staged, as before', () => {
    useFileListPrefs.setState({ advanceAfterStage: false });
    const st = run(at('b.txt'), peeks(U('a.txt', 'b.txt', 'c.txt'), S()), peeks(U('a.txt', 'c.txt'), S('b.txt')));
    expect(st.diff?.key).toBe(at('b.txt', true).key);
  });

  it('advanceTarget: undefined while the file is still in its section', () => {
    const from = { staged: false, path: 'a.txt', order: ['a.txt', 'b.txt'] };
    expect(advanceTarget(from, WT, { unstaged: U('a.txt', 'b.txt'), staged: S() }, 'diff')).toBeUndefined();
  });
});
