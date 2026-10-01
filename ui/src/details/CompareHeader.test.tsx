import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import type { FileListPayload } from '../api/gen/FileListPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { formatDate } from '../format/date';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { CompareHeader } from './CompareHeader';

/** File lists load at once (empty): the panel shows a selection once its lists are in. */
const loaded = () => fakeServices({ files: new Loader(async (): Promise<FileListPayload> => ({ files: [], added: 0, deleted: 0 }), new Lru(8)) });

const A = 'a1b2c3'.padEnd(40, '0'), B = 'e4f5a6'.padEnd(40, '0');
const OLD = 1_767_225_600, NEW = OLD + 3600;
const row = (id: string, summary: string, authorName: string, committerTime: number): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName, authorEmail: `${authorName.toLowerCase()}@example.com`, authorTime: committerTime, committerTime, parents: [], mrRefs: [], wip: null });
const wipRow: RowPayload = { ...row('wip:/r', '', '', 0), kind: 'wip', wip: { worktreePath: '/r', worktreeName: 'main-tree', modified: 2, added: 0, deleted: 0, conflicted: 0 } };
const graph: GraphPayload = { rows: [wipRow, row(B, 'Newer change with a long summary', 'Grace', NEW), row(A, 'Older change', 'Ada', OLD)], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: B, detached: false, unborn: false }, truncated: false };

describe('CompareHeader (K16, K17)', () => {
  it('shows base → target by commit date, then each commit: avatar, one-line summary and date; no swap', async () => {
    const store = createRepoViewStore(1, '/r', graph, loaded());
    // Clicked newer first: the order is still older → newer.
    await act(async () => {
      store.getState().selectRow(1);
      store.getState().selectRow(2, { ctrl: true });
    });
    render(<RepoViewContext value={store}><CompareHeader /></RepoViewContext>);
    expect(screen.getByTestId('compare-header')).toHaveTextContent('Comparing a1b2c3 → e4f5a6');
    // In the open file's bar box (K5/K6).
    expect(screen.getByTestId('compare-header').closest('.compare-bar')).toHaveClass('panel-bar');
    // Screen readers hear "to", not an arrow.
    expect(screen.getByRole('img', { name: 'to' })).toHaveTextContent('→');
    const commits = screen.getAllByTestId('compare-commit');
    expect(commits).toHaveLength(2);
    expect(within(commits[0]).getByTestId('avatar')).toBeInTheDocument();
    expect(within(commits[0]).getByTestId('compare-summary')).toHaveTextContent('Older change');
    expect(within(commits[0]).getByTestId('compare-date')).toHaveTextContent(formatDate(OLD));
    expect(within(commits[1]).getByTestId('compare-summary')).toHaveTextContent('Newer change with a long summary');
    expect(within(commits[1]).getByTestId('compare-date')).toHaveTextContent(formatDate(NEW));
    // No A/B labels and no swap: the direction is the commit dates' (K16).
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Exit compare' }));
    expect(store.getState().selection).toEqual({ kind: 'commit', index: 2, id: A });
  });

  it('compares a commit with the working tree: the commit, then the worktree; × exits to the commit', async () => {
    const store = createRepoViewStore(1, '/r', graph, loaded());
    await act(async () => store.getState().compareWithWorktree(A, '/r'));
    render(<RepoViewContext value={store}><CompareHeader /></RepoViewContext>);
    expect(screen.getByTestId('compare-header')).toHaveTextContent('Comparing a1b2c3 → working tree');
    const commits = screen.getAllByTestId('compare-commit');
    expect(within(commits[0]).getByTestId('compare-summary')).toHaveTextContent('Older change');
    expect(commits[1]).toHaveTextContent('// WIP main-tree');
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Exit compare' }));
    expect(store.getState().selection).toEqual({ kind: 'commit', index: 2, id: A });
  });

  it('a compared commit outside the loaded graph shows its short SHA', async () => {
    const store = createRepoViewStore(1, '/r', graph, loaded());
    await act(async () => store.getState().compareWithWorktree('f'.repeat(40), '/r'));
    render(<RepoViewContext value={store}><CompareHeader /></RepoViewContext>);
    const commits = screen.getAllByTestId('compare-commit');
    expect(within(commits[0]).getByTestId('compare-summary')).toHaveTextContent('ffffff');
    expect(within(commits[0]).queryByTestId('avatar')).toBeNull();
  });
});
