import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { createServices } from '../repo/services';
import { createRepoViewStore, RepoViewContext, type RepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { DetailsPanel } from './DetailsPanel';

const api = vi.hoisted(() => ({
  commitDetails: vi.fn(),
  commitMessage: vi.fn(),
  fileList: vi.fn(),
  diffContents: vi.fn(),
  signature: vi.fn(),
  treeFiles: vi.fn(),
  remotes: vi.fn(),
  openUrl: vi.fn(),
}));
vi.mock('../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../api/client')>(), api }));

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const never = () => new Promise<never>(() => {});
const commit = (id: string, summary: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: 'grace@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const wipRow: RowPayload = { ...commit('wip:/r', ''), kind: 'wip', wip: { worktreePath: '/r', worktreeName: null, modified: 1, added: 1, deleted: 0, conflicted: 0 } };
const graph: GraphPayload = { rows: [wipRow, commit(A, 'Second'), commit(B, 'First')], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false };
const file = (path: string): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object', oid: B }, new: { kind: 'worktree', worktree: '/r' }, submodule: false });
const list = (...paths: string[]): FileListPayload => ({ files: paths.map(file), added: paths.length, deleted: 0 });

function renderPanel(store: RepoViewStore) {
  render(<RepoViewContext value={store}><DetailsPanel /></RepoViewContext>);
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.commitDetails.mockImplementation(never);
  api.commitMessage.mockImplementation(never);
  api.fileList.mockImplementation(never);
  api.remotes.mockResolvedValue([]);
});

describe('DetailsPanel', () => {
  it('hints at the second Ctrl+click while the first is pending, then shows the compare header', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    renderPanel(store);
    act(() => store.getState().selectRow(2, { ctrl: true }));
    expect(screen.getByText('Ctrl+click another commit to compare')).toBeInTheDocument();
    expect(screen.getByTestId('details-summary')).toHaveTextContent('First');
    act(() => store.getState().selectRow(1, { ctrl: true }));
    expect(screen.queryByText('Ctrl+click another commit to compare')).toBeNull();
    expect(screen.getByTestId('compare-header')).toHaveTextContent(`Comparing ${B.slice(0, 6)} → ${A.slice(0, 6)}`);
    // The compare replaces the single-commit details, and lists the compare's files.
    expect(screen.queryByTestId('details-summary')).toBeNull();
    expect(store.getState().sections.map((s) => s.spec)).toEqual([{ kind: 'compare', from: B, to: A }]);
    // A plain click leaves compare mode, with no hint.
    act(() => store.getState().selectRow(2));
    expect(screen.queryByTestId('compare-header')).toBeNull();
    expect(screen.queryByText('Ctrl+click another commit to compare')).toBeNull();
    expect(screen.getByTestId('details-summary')).toHaveTextContent('First');
  });

  it('a plain click shows no compare hint', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    renderPanel(store);
    act(() => store.getState().selectRow(1));
    expect(screen.getByTestId('details-summary')).toHaveTextContent('Second');
    expect(screen.queryByText('Ctrl+click another commit to compare')).toBeNull();
  });

  it('the WIP row shows its header and read-only Unstaged and Staged lists, re-read on every selection (deviation 9)', async () => {
    let reads = 0;
    api.fileList.mockImplementation(async (_repo: number, spec: DiffSpec) => {
      if (spec.kind !== 'wip') return never();
      reads++;
      // The worktree changed between the two selections: the second read sees a new file.
      if (spec.staged) return list('src/app.php');
      return reads <= 2 ? list('notes.txt') : list('notes.txt', 'todo.txt');
    });
    const store = createRepoViewStore(1, '/r', graph, createServices(1));
    renderPanel(store);
    act(() => store.getState().selectRow(0));
    expect(screen.getByTestId('wip-header')).toHaveTextContent('// WIP Working tree ✎1 +1');
    expect(await screen.findByRole('heading', { name: 'Unstaged (1)' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Staged (1)' })).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Unstaged' })).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Staged' })).toBeInTheDocument();
    expect(screen.queryByTestId('details-summary')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /stage|discard/i })).toHaveLength(0);
    expect(api.fileList.mock.calls.map(([, spec]) => spec)).toEqual([
      { kind: 'wip', worktree: '/r', staged: false },
      { kind: 'wip', worktree: '/r', staged: true },
    ]);

    act(() => store.getState().selectRow(1));
    act(() => store.getState().selectRow(0));
    expect(await screen.findByRole('heading', { name: 'Unstaged (2)' })).toBeInTheDocument();
    expect(api.fileList.mock.calls.filter(([, spec]) => (spec as DiffSpec).kind === 'wip')).toHaveLength(4);
  });
});
