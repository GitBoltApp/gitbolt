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
import { createRepoViewStore } from './store';
import '../app/coreActions';
import { installShortcuts } from '../app/shortcuts';
import { useAppState } from '../app/state';
import { activeTabWith } from '../app/testShell';

vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));
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
    files: new Loader(async () => EMPTY_LIST, new Lru(10)),
    ...overrides,
  });
}

/** Waits a frame: PanelResizer's drag writes the live width in a `requestAnimationFrame`,
 * coalescing however many `pointermove` events land within it (K26). */
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const EMPTY_LIST: FileListPayload = { files: [], added: 0, deleted: 0 };
const realWidth = window.innerWidth;
function setWindowWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  window.dispatchEvent(new Event('resize'));
}

/** The app's shortcuts, for the tests that press Ctrl+W (removed after each test). */
let offKeys: (() => void) | undefined;

describe('RepoView', () => {
  afterEach(() => {
    offKeys?.();
    offKeys = undefined;
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

  it("the store's filterKeep (plan 1C Find) dims every other row's text at the 'filter' level, through the shared row-dim", () => {
    const store = createRepoViewStore(1, '/r', graph, services());
    render(<RepoView repo={1} repoPath="/r" graph={graph} store={store} />);
    const dimmed = () => screen.getAllByRole('row').map((r) => r.querySelector('[data-col="message"]')!.classList.contains('row-dim-filter'));
    expect(dimmed()).toEqual([false, false]);
    act(() => store.getState().setFilterKeep(new Set([B])));
    expect(dimmed()).toEqual([true, false]);
    act(() => store.getState().setFilterKeep(null));
    expect(dimmed()).toEqual([false, false]);
  });

  it('graphOverlay renders inside the graph panel, and hides with the graph while a file is open', async () => {
    const list: FileListPayload = { files: [{ path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false }], added: 1, deleted: 0 };
    const store = createRepoViewStore(1, '/r', graph, services({ files: new Loader(async () => list, new Lru(10)) }));
    render(<RepoView repo={1} repoPath="/r" graph={graph} store={store} graphOverlay={<div data-testid="overlay" />} />);
    expect(screen.getByTestId('overlay').closest('.center-panel')).not.toBeNull();
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await screen.findByRole('listbox', { name: 'Changed files' });
    await act(async () => store.getState().openFirstFile());
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('a.txt');
    expect(screen.getByTestId('overlay')).not.toBeVisible();
  });

  it('Escape leaves compare mode', async () => {
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    const rows = screen.getAllByRole('row');
    fireEvent.mouseDown(rows[1]);
    fireEvent.mouseDown(rows[0], { ctrlKey: true });
    // K15: both compared commits show as selected.
    expect(screen.getAllByRole('row').map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'true']);
    fireEvent.keyDown(screen.getByRole('grid', { name: 'Commit graph' }), { key: 'Escape' });
    expect(screen.getAllByRole('row').map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false']);
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
    expect(screen.getAllByRole('row').map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'true']);
    fireEvent.keyDown(grid, { key: 'Escape' });
    expect(screen.queryByTestId('compare-header')).toBeNull();
    expect(screen.getAllByRole('row').map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('leaving compare from the header (× or Escape on it) gives keyboard focus back to the grid', async () => {
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    const compare = async () => {
      const rows = screen.getAllByRole('row');
      fireEvent.mouseDown(rows[1]);
      fireEvent.mouseDown(rows[0], { ctrlKey: true });
      expect(await screen.findByTestId('compare-header')).toBeInTheDocument();
    };
    await compare();
    const exit = screen.getByRole('button', { name: 'Exit compare' });
    exit.focus();
    fireEvent.click(exit);
    expect(screen.queryByTestId('compare-header')).toBeNull();
    expect(document.activeElement).toBe(grid);

    await compare();
    const again = screen.getByRole('button', { name: 'Exit compare' });
    again.focus();
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(screen.queryByTestId('compare-header')).toBeNull();
    expect(document.activeElement).toBe(grid);
  });

  it('labels the right panel by what it shows', async () => {
    const wipRow: RowPayload = { ...row('wip:/r', '', []), kind: 'wip', wip: { worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, conflicted: 0 } };
    render(<RepoView repo={1} repoPath="/r" graph={{ ...graph, rows: [wipRow, ...graph.rows] }} services={services()} />);
    const rows = screen.getAllByRole('row');
    fireEvent.mouseDown(rows[1]);
    expect(await screen.findByRole('complementary', { name: 'Commit details' })).toBeInTheDocument();
    fireEvent.mouseDown(rows[2], { ctrlKey: true });
    expect(await screen.findByRole('complementary', { name: 'Compare' })).toBeInTheDocument();
    fireEvent.mouseDown(rows[0]);
    expect(await screen.findByRole('complementary', { name: 'Working tree changes' })).toBeInTheDocument();
  });

  // Review fix: a focus request while the panel is pending must not land in the stale list,
  // whose unmount on the swap would drop DOM focus to <body> (a dead keyboard).
  describe('focus while the next commit loads', () => {
    const fileOf = (path: string): FileListPayload => ({ files: [{ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object', oid: B }, new: { kind: 'object', oid: A }, submodule: false }], added: 1, deleted: 0 });
    /** A's content loads at once; B's message waits for `release()`. */
    async function pendingB() {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const msgs: Record<string, CommitMessage> = { [A]: { id: A, summary: 'Second', body: '' }, [B]: { id: B, summary: 'First', body: '' } };
      render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({
        messages: createCommitMessageCache(async (id) => { if (id === B) await gate; return msgs[id]; }),
        files: new Loader(async (k: string) => fileOf(k.includes(A) ? 'a.txt' : 'b.txt'), new Lru(10)),
      })} />);
      const grid = screen.getByRole('grid', { name: 'Commit graph' });
      fireEvent.mouseDown(screen.getAllByRole('row')[0]);
      const stale = await screen.findByRole('listbox', { name: 'Changed files' });
      await act(async () => fireEvent.mouseDown(screen.getAllByRole('row')[1]));
      expect(screen.getByRole('complementary', { name: 'Commit details' })).toHaveAttribute('aria-busy', 'true');
      grid.focus();
      return { grid, stale, release: () => act(async () => release()) };
    }

    it('→ (J2: opens the new first file) lands on the files zone, then the new list once it swaps in', async () => {
      const { grid, stale, release } = await pendingB();
      // Keys on the stale list open nothing.
      fireEvent.keyDown(stale, { key: 'ArrowDown' });
      expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
      grid.focus();
      await act(async () => fireEvent.keyDown(grid, { key: 'ArrowRight' }));
      expect(document.activeElement).not.toBe(stale);
      expect(document.activeElement).toHaveAttribute('data-focus-zone', 'files');
      await release();
      const box = screen.getByRole('listbox', { name: 'Changed files' });
      expect(box).not.toBe(stale);
      expect(document.activeElement).toBe(box);
      expect(box.querySelector('[data-path="b.txt"]')).not.toBeNull();
      fireEvent.keyDown(box, { key: 'ArrowDown' });
      expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('b.txt');
    });

    it('Enter (the list loaded before the message) opens the new first file and focus follows it', async () => {
      const { grid, stale, release } = await pendingB();
      await act(async () => fireEvent.keyDown(grid, { key: 'Enter' }));
      expect(document.activeElement).not.toBe(stale);
      await release();
      const box = screen.getByRole('listbox', { name: 'Changed files' });
      expect(document.activeElement).toBe(box);
      expect(box.querySelector('[data-path="b.txt"]')).toHaveAttribute('aria-selected', 'true');
      expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('b.txt');
    });

    it('focus lost to <body> while the store names the files returns to the new list', async () => {
      const { stale, release } = await pendingB();
      act(() => stale.focus()); // the store now names the files
      act(() => stale.blur());
      expect(document.activeElement).toBe(document.body);
      await release();
      expect(document.activeElement).toBe(screen.getByRole('listbox', { name: 'Changed files' }));
    });
  });

  // Feedback F12 replaces the old stand-in (the graph row's summary while the message loads):
  // the panel appears with everything loaded, and keeps the previous commit, whole, meanwhile.
  it('the panel appears once the commit\'s content has loaded, and keeps it (busy) while the next one loads', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const msgs: Record<string, CommitMessage> = { [A]: { id: A, summary: 'Second', body: 'Body text' }, [B]: { id: B, summary: 'First', body: '' } };
    // B's message waits for the gate; A's is immediate.
    const messages = createCommitMessageCache(async (id) => { if (id === B) await gate; return msgs[id]; });
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ messages })} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    expect(screen.queryByRole('complementary')).toBeNull(); // nothing loaded yet: no empty panel
    const panel = await screen.findByRole('complementary', { name: 'Commit details' });
    expect(screen.getByTestId('details-body')).toHaveTextContent('Body text');
    expect(panel).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByTestId('panel-busy')).toBeNull();
    await act(async () => fireEvent.mouseDown(screen.getAllByRole('row')[1]));
    // B's details and files are in; its message isn't: A stays, whole, with the busy line.
    expect(screen.getByTestId('details-summary')).toHaveTextContent('Second');
    expect(screen.getByTestId('details-body')).toHaveTextContent('Body text');
    expect(screen.getByTestId('details-sha')).toHaveTextContent(A.slice(0, 6));
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('panel-busy')).toBeInTheDocument();
    await act(async () => release());
    expect(screen.getByTestId('details-summary')).toHaveTextContent('First');
    expect(screen.getByTestId('details-sha')).toHaveTextContent(B.slice(0, 6));
    expect(screen.queryByTestId('details-body')).toBeNull();
    expect(panel).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByTestId('panel-busy')).toBeNull();
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
    // One load for the selected commit (the neighbours' messages are prefetched separately).
    expect(load.mock.calls.filter(([id]) => id === A)).toHaveLength(1);
  });

  it('the details panel is resizable between 280 and 720 px, 400 by default', async () => {
    setWindowWidth(1600);
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const panel = await screen.findByRole('complementary', { name: 'Commit details' });
    const sep = screen.getByRole('separator', { name: 'Resize details panel' });
    expect(RIGHT_PANEL).toEqual({ min: 280, max: 720, default: 400 });
    expect(panel).toHaveStyle({ width: '400px' });
    // A drag doesn't start a text selection.
    expect(fireEvent.pointerDown(sep, { clientX: 800, pointerId: 1, button: 0 })).toBe(false);
    fireEvent.pointerMove(sep, { clientX: 700, pointerId: 1 });
    await nextFrame();
    expect(panel).toHaveStyle({ width: '500px' });
    fireEvent.pointerMove(sep, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientX: 0, pointerId: 1 }); // ends before the queued frame fires
    expect(panel).toHaveStyle({ width: '720px' });
    for (let i = 0; i < 40; i++) fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(panel).toHaveStyle({ width: '280px' });
    expect(sep).toHaveAttribute('aria-valuenow', '280');
    fireEvent.keyDown(sep, { key: 'End' });
    expect(panel).toHaveStyle({ width: '720px' });
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(panel).toHaveStyle({ width: '280px' });
  });

  it('losing pointer capture ends a drag', async () => {
    setWindowWidth(1600);
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const panel = await screen.findByRole('complementary', { name: 'Commit details' });
    const sep = screen.getByRole('separator', { name: 'Resize details panel' });
    fireEvent.pointerDown(sep, { clientX: 800, pointerId: 1, button: 0 });
    fireEvent.lostPointerCapture(sep, { pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 700, pointerId: 1 });
    expect(panel).toHaveStyle({ width: '400px' });
  });

  it('on a narrow window the panel leaves the center at least 320 px, re-clamped on resize', async () => {
    setWindowWidth(900);
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const panel = await screen.findByRole('complementary', { name: 'Commit details' });
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

  it('J2: → in the graph opens the first file as the list displays it and focuses the list; with none, it stays', async () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'status', allFiles: false });
    const f = (path: string, status: string) => ({ path, oldPath: null, status, additions: 1, deletions: 0, old: { kind: 'object' as const, oid: B }, new: { kind: 'object' as const, oid: A }, submodule: false });
    const list: FileListPayload = { files: [f('a.txt', 'M'), f('z.txt', 'A')], added: 2, deleted: 0 };
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ files: new Loader(async (k: string) => (k.includes(A) ? list : EMPTY_LIST), new Lru(10)) })} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    expect(grid).toHaveAttribute('data-focus-zone', 'graph');
    // An empty commit: nothing to open, the graph keeps the keyboard.
    fireEvent.mouseDown(screen.getAllByRole('row')[1]);
    await screen.findByRole('listbox', { name: 'Changed files' });
    grid.focus();
    expect(fireEvent.keyDown(grid, { key: 'ArrowRight' })).toBe(false); // handled: default prevented
    expect(document.activeElement).toBe(grid);
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await screen.findByText('z.txt');
    grid.focus();
    await act(async () => fireEvent.keyDown(grid, { key: 'ArrowRight' }));
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('z.txt');
    const box = screen.getByRole('listbox', { name: 'Changed files' });
    expect(document.activeElement).toBe(box);
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('opening a diff hands DOM focus to the file list; → on the open file does nothing and Escape closes it back to the graph', async () => {
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
    expect(document.activeElement).toBe(box);
    act(() => region.focus());
    fireEvent.keyDown(region, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
    expect(screen.getByRole('grid', { name: 'Commit graph' })).toBe(grid);
    expect(document.activeElement).toBe(grid);
    expect(screen.getAllByRole('row')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('Ctrl+W closes the open file from the file list (as Escape does); with none open, the tab', async () => {
    const list: FileListPayload = { files: [{ path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false }], added: 1, deleted: 0 };
    // Ctrl+W is the app's shortcut (plan 1C), acting on the active tab's store.
    const store = activeTabWith(createRepoViewStore(1, '/r', graph, services({ files: new Loader(async () => list, new Lru(10)) })));
    offKeys = installShortcuts();
    render(<RepoView repo={1} repoPath="/r" graph={graph} store={store} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    const box = await screen.findByRole('listbox', { name: 'Changed files' });
    grid.focus();
    await act(async () => fireEvent.keyDown(grid, { key: 'Enter' }));
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('a.txt');
    expect(fireEvent.keyDown(box, { key: 'w', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(screen.getByRole('region', { name: 'Diff' })).toBeInTheDocument();
    expect(fireEvent.keyDown(box, { key: 'w', ctrlKey: true })).toBe(false);
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
    expect(useAppState.getState().profile.tabs.map((t) => t.id)).toEqual(['t', 'u']);
    // No file open: the tab.
    expect(fireEvent.keyDown(grid, { key: 'w', ctrlKey: true })).toBe(false);
    expect(useAppState.getState().profile.tabs.map((t) => t.id)).toEqual(['u']);
  });

  it('with DiffPanel inside RepoView: Esc is left to an open editor overlay, Ctrl+W closes the file regardless', async () => {
    const list: FileListPayload = { files: [{ path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false }], added: 1, deleted: 0 };
    const store = activeTabWith(createRepoViewStore(1, '/r', graph, services({ files: new Loader(async () => list, new Lru(10)) })));
    offKeys = installShortcuts();
    render(<RepoView repo={1} repoPath="/r" graph={graph} store={store} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await screen.findByRole('listbox', { name: 'Changed files' });
    grid.focus();
    await act(async () => fireEvent.keyDown(grid, { key: 'Enter' }));
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('a.txt');
    const region = screen.getByRole('region', { name: 'Diff' });
    // A Monaco content hover (Monaco hides it on Esc without stopping the event): shown, in the panel.
    const hover = document.createElement('div');
    hover.className = 'monaco-hover';
    hover.getClientRects = () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
    const editor = Object.assign(document.createElement('div'), { className: 'monaco-editor' });
    const input = editor.appendChild(document.createElement('textarea'));
    region.append(hover, editor);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('region', { name: 'Diff' })).toBeInTheDocument();
    // Ctrl+W always closes the file, overlay or not (as VS Code does).
    expect(fireEvent.keyDown(input, { key: 'w', ctrlKey: true })).toBe(false);
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
  });

  it('with DiffPanel inside RepoView: Esc with no overlay open closes the file', async () => {
    const list: FileListPayload = { files: [{ path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false }], added: 1, deleted: 0 };
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ files: new Loader(async () => list, new Lru(10)) })} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await screen.findByRole('listbox', { name: 'Changed files' });
    grid.focus();
    await act(async () => fireEvent.keyDown(grid, { key: 'Enter' }));
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('a.txt');
    const region = screen.getByRole('region', { name: 'Diff' });
    const hidden = document.createElement('div');
    hidden.className = 'monaco-hover hidden';
    const editor = Object.assign(document.createElement('div'), { className: 'monaco-editor' });
    const input = editor.appendChild(document.createElement('textarea'));
    region.append(hidden, editor);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
  });

  describe('J4: Esc closes the open file wherever the focus is', () => {
    const list: FileListPayload = { files: [{ path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false }], added: 1, deleted: 0 };
    async function openA() {
      const view = render(<RepoView repo={1} repoPath="/r" graph={graph} services={services({ files: new Loader(async () => list, new Lru(10)) })} />);
      const grid = screen.getByRole('grid', { name: 'Commit graph' });
      fireEvent.mouseDown(screen.getAllByRole('row')[0]);
      await screen.findByRole('listbox', { name: 'Changed files' });
      grid.focus();
      await act(async () => fireEvent.keyDown(grid, { key: 'Enter' }));
      expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('a.txt');
      return { grid, view };
    }
    const diffOpen = () => screen.queryByRole('region', { name: 'Diff' }) !== null;

    it('from <body> (a click on the details header\'s blank area), the details header and the message', async () => {
      for (const from of ['body', 'sha', 'message'] as const) {
        const { grid, view } = await openA();
        const el = from === 'body' ? document.body : from === 'sha' ? screen.getByTestId('details-sha') : screen.getByTestId('commit-message');
        if (from === 'body') act(() => (document.activeElement as HTMLElement | null)?.blur());
        else act(() => el.focus());
        expect(fireEvent.keyDown(el, { key: 'Escape' }), from).toBe(false);
        expect(diffOpen(), from).toBe(false);
        expect(document.activeElement, from).toBe(grid);
        expect(screen.getAllByRole('row')[0]).toHaveAttribute('aria-selected', 'true');
        view.unmount();
      }
    });

    it('leaves Esc to a menu: one it comes from, or any shown one (focus kept on its trigger)', async () => {
      await openA();
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      const item = menu.appendChild(document.createElement('button'));
      document.body.append(menu);
      expect(fireEvent.keyDown(item, { key: 'Escape' })).toBe(true);
      expect(diffOpen()).toBe(true);
      // Shown, with the focus elsewhere (on its trigger): still the menu's.
      menu.getClientRects = () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
      expect(fireEvent.keyDown(screen.getByTestId('details-sha'), { key: 'Escape' })).toBe(true);
      expect(diffOpen()).toBe(true);
      // Hidden (no box): not open.
      menu.getClientRects = () => [] as unknown as DOMRectList;
      expect(fireEvent.keyDown(screen.getByTestId('details-sha'), { key: 'Escape' })).toBe(false);
      expect(diffOpen()).toBe(false);
      menu.remove();
    });

    it('an open find widget claims Esc only from inside the editor: from the file list, Esc closes the diff', async () => {
      await openA();
      const region = screen.getByRole('region', { name: 'Diff' });
      const editor = Object.assign(document.createElement('div'), { className: 'monaco-editor' });
      const find = Object.assign(document.createElement('div'), { className: 'find-widget visible' });
      find.getClientRects = () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
      const input = document.createElement('textarea');
      editor.append(find, input);
      region.append(editor);
      // Inside the editor: the find widget's (left to Monaco, unhandled here); the file stays.
      expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
      expect(diffOpen()).toBe(true);
      // From the file list: the file closes, and the find widget with it.
      const box = screen.getByRole('listbox', { name: 'Changed files' });
      act(() => box.focus());
      expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(false);
      expect(diffOpen()).toBe(false);
      expect(document.activeElement).toBe(screen.getByRole('grid', { name: 'Commit graph' }));
    });

    it('a find widget that is `.visible` but not on screen (a hidden, kept editor) claims nothing', async () => {
      await openA();
      const region = screen.getByRole('region', { name: 'Diff' });
      const editor = Object.assign(document.createElement('div'), { className: 'monaco-editor' });
      // jsdom: no box, so not shown, whatever its class says.
      const find = Object.assign(document.createElement('div'), { className: 'find-widget visible' });
      const input = document.createElement('textarea');
      editor.append(find, input);
      region.append(editor);
      expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
      expect(diffOpen()).toBe(false);
    });

    it("a find widget open anywhere doesn't block Esc from the details header; with a modifier, Esc doesn't act", async () => {
      await openA();
      const find = Object.assign(document.createElement('div'), { className: 'find-widget visible' });
      find.getClientRects = () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
      document.body.append(find);
      expect(fireEvent.keyDown(document.body, { key: 'Escape', ctrlKey: true })).toBe(true);
      expect(diffOpen()).toBe(true);
      expect(fireEvent.keyDown(screen.getByTestId('details-sha'), { key: 'Escape' })).toBe(false);
      expect(diffOpen()).toBe(false);
      find.remove();
    });

    it("an app text box keeps its Esc (plan 1C's search box); a shown HoverTooltip is dismissed first", async () => {
      await openA();
      const search = Object.assign(document.createElement('input'), { type: 'search' });
      document.body.append(search);
      expect(fireEvent.keyDown(search, { key: 'Escape' })).toBe(true);
      expect(diffOpen()).toBe(true);
      search.remove();
      // The details SHA's instant tooltip: the first Esc dismisses it, the next closes the file.
      const sha = screen.getByTestId('details-sha');
      fireEvent.mouseEnter(sha);
      expect(screen.getByRole('tooltip')).toHaveTextContent('Copy full SHA');
      fireEvent.keyDown(sha, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(diffOpen()).toBe(true);
      fireEvent.keyDown(sha, { key: 'Escape' });
      expect(diffOpen()).toBe(false);
    });

    it('with no file open, Esc outside the view does nothing, and the listener goes with the view', async () => {
      const { view } = await openA();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true); // nothing to close
      view.unmount();
      expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
    });
  });

  it('ArrowRight from the graph opens the first file and focuses the list once it has loaded, and ← closes it back to the graph', async () => {
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
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('a.txt');
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
    expect(document.activeElement).toBe(grid);
    expect(screen.getAllByRole('row')[0]).toHaveAttribute('aria-selected', 'true');
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
    await act(async () => fireEvent.keyDown(grid, { key: 'ArrowRight' }));
    expect(document.activeElement).toBe(stagedBox);
    expect(await screen.findByTestId('diff-path', {}, { timeout: 5000 })).toHaveTextContent('s.txt');
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
      const region = screen.getByRole('region', { name: 'Diff' });
      act(() => region.focus());
      fireEvent.keyDown(region, { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(box);
    }
  });
});
