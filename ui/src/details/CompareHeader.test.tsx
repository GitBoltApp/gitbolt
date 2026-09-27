import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { CompareHeader } from './CompareHeader';

const A = 'a1b2c3'.padEnd(40, '0'), B = 'e4f5a6'.padEnd(40, '0');
const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graph: GraphPayload = { rows: [row(B), row(A)], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: B, detached: false, unborn: false }, truncated: false };

describe('CompareHeader', () => {
  it('shows from → to, swaps and exits', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    act(() => {
      store.getState().selectRow(1, { ctrl: true });
      store.getState().selectRow(0, { ctrl: true });
    });
    render(<RepoViewContext value={store}><CompareHeader /></RepoViewContext>);
    expect(screen.getByTestId('compare-header')).toHaveTextContent('Comparing a1b2c3 → e4f5a6');
    // Screen readers hear "to", not an arrow.
    expect(screen.getByRole('img', { name: 'to' })).toHaveTextContent('→');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(screen.getByTestId('compare-header')).toHaveTextContent('Comparing e4f5a6 → a1b2c3');
    fireEvent.click(screen.getByRole('button', { name: 'Exit compare' }));
    expect(store.getState().selection.kind).toBe('commit');
  });

  it('compares a commit with the working tree: no swap, and × exits to that commit', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    act(() => store.getState().compareWithWorktree(A, '/r'));
    render(<RepoViewContext value={store}><CompareHeader /></RepoViewContext>);
    expect(screen.getByTestId('compare-header')).toHaveTextContent('Comparing a1b2c3 → working tree');
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Exit compare' }));
    expect(store.getState().selection).toEqual({ kind: 'commit', index: 1, id: A });
  });
});
