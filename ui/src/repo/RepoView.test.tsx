import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommitMessageCache } from '../api/commitMessages';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { copyText } from '../api/transport';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { useToast } from '../ui/toast';
import { useFileListPrefs } from '../files/fileListPrefs';
import { RepoView, RIGHT_PANEL } from './RepoView';
import type { RepoServices } from './services';
import { fakeServices } from './testServices';

vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const row = (id: string, summary: string, parents: string[]): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: 'grace@example.com', authorTime: 1_767_225_600, committerTime: 1_767_225_600, parents, mrRefs: [], wip: null });
const graph: GraphPayload = { rows: [row(A, 'Second', [B]), row(B, 'First', [])], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false };
const details = (id: string, parents: string[]): CommitDetailsPayload => ({
  id, parents, coAuthors: [], signed: false,
  author: { name: 'Grace Hopper', email: 'grace@example.com', time: 1_767_225_600 },
  committer: { name: 'Ada Lovelace', email: 'ada@example.com', time: 1_767_225_660 },
});

function services(overrides: Partial<RepoServices> = {}): RepoServices {
  const byId: Record<string, CommitDetailsPayload> = { [A]: details(A, [B]), [B]: details(B, []) };
  const msgs: Record<string, CommitMessage> = { [A]: { id: A, summary: 'Second', body: 'Body text' }, [B]: { id: B, summary: 'First', body: '' } };
  return fakeServices({
    details: new Loader(async (id) => byId[id], new Lru(10)),
    messages: createCommitMessageCache(async (id) => msgs[id]),
    ...overrides,
  });
}

const realWidth = window.innerWidth;
function setWindowWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  window.dispatchEvent(new Event('resize'));
}

describe('RepoView', () => {
  afterEach(() => {
    setWindowWidth(realWidth);
    vi.mocked(copyText).mockClear();
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
  });

  it('shows the details panel once a commit is selected, and parents navigate', async () => {
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    expect(screen.queryByRole('complementary', { name: 'Commit details' })).toBeNull();
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    expect(await screen.findByTestId('details-body')).toHaveTextContent('Body text');
    expect(screen.getByTestId('details-summary')).toHaveTextContent('Second');
    expect(screen.getByTestId('author')).toHaveTextContent('Grace Hopper');
    expect(screen.getByTestId('committer')).toHaveTextContent('Ada Lovelace');
    await act(async () => fireEvent.click(screen.getByTestId('parent-sha')));
    expect(await screen.findByText('First', { selector: '[data-testid="details-summary"]' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('Escape leaves compare mode', async () => {
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    const rows = screen.getAllByRole('row');
    fireEvent.mouseDown(rows[1], { ctrlKey: true });
    fireEvent.mouseDown(rows[0], { ctrlKey: true });
    expect(screen.getByTestId('compare-a')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('grid', { name: 'Commit graph' }), { key: 'Escape' });
    expect(screen.queryByTestId('compare-a')).toBeNull();
    expect(screen.getAllByRole('row')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('Escape in the file list returns to the graph (closeDiff) and keeps comparing; Escape in the grid leaves compare', async () => {
    const f = { path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object' as const, oid: B }, new: { kind: 'object' as const, oid: A }, submodule: false };
    const list: FileListPayload = { files: [f], added: 1, deleted: 0 };
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ files: new Loader(async () => list, new Lru(10)) })} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    const rows = screen.getAllByRole('row');
    fireEvent.mouseDown(rows[1], { ctrlKey: true });
    fireEvent.mouseDown(rows[0], { ctrlKey: true });
    const box = await screen.findByRole('listbox', { name: 'Changed files' });
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(document.activeElement).toBe(grid);
    expect(screen.getByTestId('compare-header')).toBeInTheDocument();
    expect(screen.getByTestId('compare-a')).toBeInTheDocument();
    fireEvent.keyDown(grid, { key: 'Escape' });
    expect(screen.queryByTestId('compare-header')).toBeNull();
    expect(screen.queryByTestId('compare-a')).toBeNull();
  });

  it('leaving compare from the header (× or Escape on Swap) gives keyboard focus back to the grid', () => {
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    const compare = () => {
      const rows = screen.getAllByRole('row');
      fireEvent.mouseDown(rows[1], { ctrlKey: true });
      fireEvent.mouseDown(rows[0], { ctrlKey: true });
      expect(screen.getByTestId('compare-header')).toBeInTheDocument();
    };
    compare();
    const exit = screen.getByRole('button', { name: 'Exit compare' });
    exit.focus();
    fireEvent.click(exit);
    expect(screen.queryByTestId('compare-header')).toBeNull();
    expect(document.activeElement).toBe(grid);

    compare();
    const swap = screen.getByRole('button', { name: 'Swap' });
    swap.focus();
    fireEvent.keyDown(swap, { key: 'Escape' });
    expect(screen.queryByTestId('compare-header')).toBeNull();
    expect(document.activeElement).toBe(grid);
  });

  it('labels the right panel by what it shows', () => {
    const wipRow: RowPayload = { ...row('wip:/r', '', []), kind: 'wip', wip: { worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, conflicted: 0 } };
    render(<RepoView repo={1} repoPath="/r" graph={{ ...graph, rows: [wipRow, ...graph.rows] }} services={services()} />);
    const rows = screen.getAllByRole('row');
    fireEvent.mouseDown(rows[1]);
    expect(screen.getByRole('complementary', { name: 'Commit details' })).toBeInTheDocument();
    fireEvent.mouseDown(rows[2], { ctrlKey: true });
    fireEvent.mouseDown(rows[1], { ctrlKey: true });
    expect(screen.getByRole('complementary', { name: 'Compare' })).toBeInTheDocument();
    fireEvent.mouseDown(rows[0]);
    expect(screen.getByRole('complementary', { name: 'Working tree changes' })).toBeInTheDocument();
  });

  it('shows the graph row\'s summary and first body line at once, before the full message has loaded', () => {
    // The message never loads: the placeholder is the selected commit's own row text, so fast
    // Up/Down doesn't flash an empty panel.
    const g: GraphPayload = { ...graph, rows: [{ ...graph.rows[0], bodyFirstLine: 'Body first line' }, graph.rows[1]] };
    render(<RepoView repo={1} repoPath="/r" graph={g} services={services({ messages: fakeServices().messages })} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    expect(screen.getByTestId('details-summary')).toHaveTextContent('Second');
    expect(screen.getByTestId('details-body')).toHaveTextContent('Body first line');
    expect(screen.getByTestId('details-body')).toHaveAttribute('aria-busy', 'true');
    fireEvent.mouseDown(screen.getAllByRole('row')[1]);
    expect(screen.getByTestId('details-summary')).toHaveTextContent('First');
    expect(screen.queryByTestId('details-body')).toBeNull();
  });

  it('a failed message load shows an error instead of the body', async () => {
    const messages = createCommitMessageCache(async () => { throw new Error('boom'); });
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ messages })} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('the graph tooltip and the details panel share one message cache', async () => {
    const load = vi.fn(async (id: string): Promise<CommitMessage> => ({ id, summary: 'Second', body: 'Body text' }));
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ messages: createCommitMessageCache(load) })} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    expect(await screen.findByTestId('details-body')).toHaveTextContent('Body text');
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(screen.getAllByRole('row')[0].querySelector('[data-col="message"]')!);
      await act(async () => vi.advanceTimersByTime(500));
      expect(screen.getByRole('tooltip')).toHaveTextContent('Body text');
    } finally {
      vi.useRealTimers();
    }
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('the details panel is resizable between 280 and 720 px, 400 by default', () => {
    setWindowWidth(1600);
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const panel = screen.getByRole('complementary', { name: 'Commit details' });
    const sep = screen.getByRole('separator', { name: 'Resize details panel' });
    expect(RIGHT_PANEL).toEqual({ min: 280, max: 720, default: 400 });
    expect(panel).toHaveStyle({ width: '400px' });
    // A drag doesn't start a text selection.
    expect(fireEvent.pointerDown(sep, { clientX: 800, pointerId: 1, button: 0 })).toBe(false);
    fireEvent.pointerMove(sep, { clientX: 700, pointerId: 1 });
    expect(panel).toHaveStyle({ width: '500px' });
    fireEvent.pointerMove(sep, { clientX: 0, pointerId: 1 });
    expect(panel).toHaveStyle({ width: '720px' });
    fireEvent.pointerUp(sep, { clientX: 0, pointerId: 1 });
    for (let i = 0; i < 40; i++) fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(panel).toHaveStyle({ width: '280px' });
    expect(sep).toHaveAttribute('aria-valuenow', '280');
    fireEvent.keyDown(sep, { key: 'End' });
    expect(panel).toHaveStyle({ width: '720px' });
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(panel).toHaveStyle({ width: '280px' });
  });

  it('losing pointer capture ends a drag', () => {
    setWindowWidth(1600);
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const panel = screen.getByRole('complementary', { name: 'Commit details' });
    const sep = screen.getByRole('separator', { name: 'Resize details panel' });
    fireEvent.pointerDown(sep, { clientX: 800, pointerId: 1, button: 0 });
    fireEvent.lostPointerCapture(sep, { pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 700, pointerId: 1 });
    expect(panel).toHaveStyle({ width: '400px' });
  });

  it('on a narrow window the panel leaves the center at least 320 px, re-clamped on resize', () => {
    setWindowWidth(900);
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const panel = screen.getByRole('complementary', { name: 'Commit details' });
    const sep = screen.getByRole('separator', { name: 'Resize details panel' });
    expect(sep).toHaveAttribute('aria-valuemax', '580');
    fireEvent.keyDown(sep, { key: 'End' });
    expect(panel).toHaveStyle({ width: '580px' });
    act(() => setWindowWidth(700));
    expect(panel).toHaveStyle({ width: '380px' });
    expect(sep).toHaveAttribute('aria-valuemax', '380');
    // Never below the panel's own minimum.
    act(() => setWindowWidth(400));
    expect(panel).toHaveStyle({ width: '280px' });
  });

  it('Enter on a focused row SHA button copies instead of opening a diff', async () => {
    const list: FileListPayload = { files: [{ path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false }], added: 1, deleted: 0 };
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ files: new Loader(async () => list, new Lru(10)) })} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await act(async () => {});
    const sha = screen.getAllByTestId('sha')[0];
    sha.focus();
    expect(fireEvent.keyDown(sha, { key: 'Enter' })).toBe(true); // the browser's Enter → click still happens
    await act(async () => fireEvent.click(sha));
    expect(copyText).toHaveBeenCalledWith(A);
    await act(async () => {});
    expect(screen.getByRole('grid', { name: 'Commit graph' })).toBeInTheDocument(); // no diff opened
    // Control: Enter on the grid itself does open the first file (the graph is hidden).
    await act(async () => fireEvent.keyDown(screen.getByRole('grid', { name: 'Commit graph' }), { key: 'Enter' }));
    expect(screen.queryByRole('grid', { name: 'Commit graph' })).toBeNull();
  });

  it('a failed copy of the details SHA shows a toast instead of an unhandled rejection', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('clipboard denied'));
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await act(async () => fireEvent.click(await screen.findByTestId('details-sha')));
    expect(useToast.getState().message).toBe('Copy failed');
  });

  it('ArrowRight in the graph moves the focus zone to the files', () => {
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    expect(grid).toHaveAttribute('data-focus-zone', 'graph');
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    expect(fireEvent.keyDown(grid, { key: 'ArrowRight' })).toBe(false); // handled: default prevented
    expect(grid).toHaveAttribute('data-zone-focused', 'false');
  });

  it('opening a diff hands DOM focus to the file list; → focuses the diff and Escape closes it back to the graph', async () => {
    const list: FileListPayload = { files: [{ path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false }], added: 1, deleted: 0 };
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ files: new Loader(async () => list, new Lru(10)) })} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const box = await screen.findByRole('listbox', { name: 'Changed files' });
    grid.focus();
    await act(async () => fireEvent.keyDown(grid, { key: 'Enter' }));
    // The graph is hidden under the diff: focus must not fall back to <body>.
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('a.txt'); // the lazy panel has loaded
    expect(document.activeElement).toBe(box);
    expect(box.closest('[data-focus-zone]')).toHaveAttribute('data-zone-focused', 'true');
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    const region = screen.getByRole('region', { name: 'Diff' });
    expect(document.activeElement).toBe(region);
    fireEvent.keyDown(region, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
    expect(screen.getByRole('grid', { name: 'Commit graph' })).toBe(grid);
    expect(document.activeElement).toBe(grid);
    expect(screen.getAllByRole('row')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowRight from the graph focuses the file list once it has loaded, and ← returns', async () => {
    // Every file-list load (the selected commit's and its prefetched neighbour's) waits for this.
    const pending: ((l: FileListPayload) => void)[] = [];
    const list: FileListPayload = { files: [{ path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false }], added: 1, deleted: 0 };
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ files: new Loader(() => new Promise<FileListPayload>((r) => { pending.push(r); }), new Lru(10)) })} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(screen.queryByRole('listbox')).toBeNull();
    await act(async () => pending.forEach((r) => r(list)));
    const box = screen.getByRole('listbox', { name: 'Changed files' });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(grid);
  });

  it('a WIP row with only staged changes: → and Enter focus the Staged list, never the empty Unstaged one', async () => {
    const wipRow: RowPayload = { ...row('wip:/r', 'Uncommitted changes', []), kind: 'wip', wip: { worktreePath: '/r', worktreeName: null, modified: 0, added: 1, deleted: 0, conflicted: 0 } };
    const g: GraphPayload = { ...graph, rows: [wipRow, ...graph.rows] };
    const staged: FileListPayload = { files: [{ path: 's.txt', oldPath: null, status: 'A', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'object', oid: B }, submodule: false }], added: 1, deleted: 0 };
    const files = new Loader(async (k: string) => (k.includes('"staged":true') ? staged : { files: [], added: 0, deleted: 0 }), new Lru<string, FileListPayload>(10));
    render(<RepoView repo={1} repoPath="/r" graph={g} services={services({ files })} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const stagedBox = await screen.findByRole('listbox', { name: 'Staged' });
    await screen.findByRole('listbox', { name: 'Unstaged' });
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(stagedBox);
    fireEvent.keyDown(stagedBox, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(grid);
    await act(async () => fireEvent.keyDown(grid, { key: 'Enter' }));
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('s.txt');
    expect(document.activeElement).toBe(stagedBox);
  });

  it('Enter in the graph opens the first file as the list displays it (Sort by status)', async () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'status', allFiles: false });
    const f = (path: string, status: string) => ({ path, oldPath: null, status, additions: 1, deletions: 0, old: { kind: 'object' as const, oid: B }, new: { kind: 'object' as const, oid: A }, submodule: false });
    const list: FileListPayload = { files: [f('a.txt', 'M'), f('z.txt', 'A')], added: 2, deleted: 0 };
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ files: new Loader(async () => list, new Lru(10)) })} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await screen.findByRole('listbox', { name: 'Changed files' });
    await act(async () => fireEvent.keyDown(grid, { key: 'Enter' }));
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('z.txt');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('WIP with both lists non-empty: ← from the diff focuses the list holding the open file', async () => {
    const wipRow: RowPayload = { ...row('wip:/r', 'Uncommitted changes', []), kind: 'wip', wip: { worktreePath: '/r', worktreeName: null, modified: 1, added: 1, deleted: 0, conflicted: 0 } };
    const g: GraphPayload = { ...graph, rows: [wipRow, ...graph.rows] };
    const f = (path: string, staged: boolean) => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object' as const, oid: B }, new: staged ? { kind: 'object' as const, oid: A } : { kind: 'worktree' as const, worktree: '/r' }, submodule: false });
    const files = new Loader(async (k: string) => (k.includes('"staged":true') ? { files: [f('s.txt', true)], added: 1, deleted: 0 } : { files: [f('u.txt', false)], added: 1, deleted: 0 }), new Lru<string, FileListPayload>(10));
    render(<RepoView repo={1} repoPath="/r" graph={g} services={services({ files })} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const unstagedBox = await screen.findByRole('listbox', { name: 'Unstaged' });
    const stagedBox = await screen.findByRole('listbox', { name: 'Staged' });
    // Unstaged comes first, so the list with the open file must win over "the first with rows".
    for (const [box, path] of [[stagedBox, 's.txt'], [unstagedBox, 'u.txt']] as const) {
      fireEvent.mouseDown(box.querySelector(`[data-path="${path}"]`)!);
      expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent(path);
      box.focus();
      fireEvent.keyDown(box, { key: 'ArrowRight' });
      const region = screen.getByRole('region', { name: 'Diff' });
      expect(document.activeElement).toBe(region);
      fireEvent.keyDown(region, { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(box);
    }
  });
});
