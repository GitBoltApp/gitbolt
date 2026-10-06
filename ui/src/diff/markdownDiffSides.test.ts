import { describe, expect, it } from 'vitest';
import type { BlobSource } from '../api/gen/BlobSource';
import type { RowPayload } from '../api/gen/RowPayload';
import type { DiffTarget, RepoViewState, Selection } from '../repo/store';
import { oldCommitOf } from './markdownDiffSides';

const P0 = 'a'.repeat(40);
const P1 = 'b'.repeat(40);
const C = 'c'.repeat(40);
const H = 'd'.repeat(40);
const F = 'f'.repeat(40);
const row = (id: string, parents: string[]) => ({ id, parents }) as unknown as RowPayload;
const state = (selection: Selection, parent = 0) => ({
  selection, parent,
  graph: { rows: [row('wip:/r', [H]), row(C, [P0, P1])] },
  indexById: new Map([['wip:/r', 0], [C, 1]]),
}) as unknown as Pick<RepoViewState, 'selection' | 'parent' | 'graph' | 'indexById'>;
const target = (old: BlobSource): DiffTarget => ({ key: 'k', path: 'guide.md', oldPath: null, status: 'M', old, new: { kind: 'object', oid: 'e'.repeat(40) }, view: 'diff' });
const blob: BlobSource = { kind: 'object', oid: '1'.repeat(40) };

describe('oldCommitOf (5C, R9)', () => {
  it.each([
    ['a commit: its shown parent', state({ kind: 'commit', index: 1, id: C }), P0],
    ['a merge with parent 2 shown', state({ kind: 'commit', index: 1, id: C }, 1), P1],
    ['a compare: FROM', state({ kind: 'compare', from: F, to: C }), F],
    ['a compare with the working tree: FROM', state({ kind: 'compareWorktree', from: F, worktree: '/r' }), F],
    ["a WIP row: the worktree's HEAD", state({ kind: 'wip', index: 0, worktree: '/r', name: null }), H],
    ['nothing selected', state({ kind: 'none' }), null],
  ])('%s', (_name, s, want) => {
    expect(oldCommitOf(s, target(blob))).toBe(want);
  });

  it("a side's own source wins: absent, at a commit, the working tree", () => {
    const s = state({ kind: 'commit', index: 1, id: C });
    expect(oldCommitOf(s, target({ kind: 'absent' }))).toBeNull();
    expect(oldCommitOf(s, target({ kind: 'atCommit', commit: F }))).toBe(F);
    expect(oldCommitOf(s, target({ kind: 'worktree', worktree: '/r' }))).toBe('worktree');
  });
});
