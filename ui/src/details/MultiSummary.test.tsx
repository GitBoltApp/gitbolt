import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { formatDate } from '../format/date';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { DetailsPanel } from './DetailsPanel';

const [A, B, C] = ['a', 'b', 'c'].map((c) => c.repeat(40));
const T = 1_767_225_600;
const row = (id: string, summary: string, authorName: string, committerTime: number): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName, authorEmail: `${authorName.toLowerCase()}@example.com`, authorTime: committerTime, committerTime, parents: [], mrRefs: [], wip: null });
const wipRow: RowPayload = { ...row('wip:/r', '', '', 0), kind: 'wip', wip: { worktreePath: '/r', worktreeName: 'main-tree', modified: 2, added: 0, deleted: 0, renamed: 0, conflicted: 0 } };
const graph: GraphPayload = {
  rows: [wipRow, row(A, 'Third change', 'Ada', T + 7200), row(B, 'Second change', 'Grace', T + 3600), row(C, 'First change', 'Linus', T)],
  labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: A, detached: false, unborn: false }, truncated: false, worktrees: [],
};

describe('MultiSummary (K27)', () => {
  it('three or more selected rows: a count, then one row per commit (avatar, message, date), newest first; no diff, no file list', async () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    // Picked in another order than the graph's.
    await act(async () => {
      store.getState().selectRow(3);
      store.getState().selectRow(1, { ctrl: true });
      store.getState().selectRow(2, { ctrl: true });
    });
    render(<RepoViewContext value={store}><DetailsPanel /></RepoViewContext>);
    expect(screen.getByTestId('multi-count')).toHaveTextContent('3 commits selected');
    // In the same bar box as the commit and compare headers.
    expect(screen.getByTestId('multi-count').closest('.multi-bar')).toHaveClass('panel-bar');
    const commits = screen.getAllByTestId('multi-commit');
    expect(commits.map((c) => within(c).getByTestId('compare-summary').textContent)).toEqual(['Third change', 'Second change', 'First change']);
    expect(within(commits[0]).getByTestId('avatar')).toBeInTheDocument();
    expect(within(commits[2]).getByTestId('compare-date')).toHaveTextContent(formatDate(T));
    // No compare header, no file list, no action buttons (those come later).
    expect(screen.queryByTestId('compare-header')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Exit multi-selection']);
    // × goes back to the anchor alone: the row Ctrl+clicked last.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Exit multi-selection' })));
    expect(store.getState().selection).toEqual({ kind: 'commit', index: 2, id: B });
  });

  it('the WIP row in a multi-selection is listed as the working tree', async () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    await act(async () => {
      store.getState().selectRow(0);
      store.getState().selectRow(2, { shift: true });
    });
    render(<RepoViewContext value={store}><DetailsPanel /></RepoViewContext>);
    expect(screen.getByTestId('multi-count')).toHaveTextContent('3 commits selected');
    const commits = screen.getAllByTestId('multi-commit');
    expect(commits[0]).toHaveTextContent('// WIP main-tree');
    expect(commits.slice(1).map((c) => within(c).getByTestId('compare-summary').textContent)).toEqual(['Third change', 'Second change']);
  });

  it('a Shift range over 5,000 commits renders only the rows in view (virtualized), all scrollable', async () => {
    const many: GraphPayload = { ...graph, rows: Array.from({ length: 5000 }, (_, i) => row(String(i).padStart(40, '0'), `Change ${i}`, 'Ada', T - i)) };
    const store = createRepoViewStore(1, '/r', many, fakeServices());
    await act(async () => {
      store.getState().selectRow(0);
      store.getState().selectRow(4999, { shift: true });
    });
    render(<RepoViewContext value={store}><DetailsPanel /></RepoViewContext>);
    expect(screen.getByTestId('multi-count')).toHaveTextContent('5000 commits selected');
    const shown = screen.getAllByTestId('multi-commit');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(100);
    expect(within(shown[0]).getByTestId('compare-summary')).toHaveTextContent('Change 0');
    // The scroll area is as tall as all 5,000 rows.
    const inner = screen.getByTestId('multi-commits').firstElementChild as HTMLElement;
    expect(parseFloat(inner.style.height)).toBe(5000 * 30);
  });
});
