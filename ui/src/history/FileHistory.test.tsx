import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Activity } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { FileHistoryPage } from '../api/gen/FileHistoryPage';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { useTabViews } from '../app/tabStores';
import { centerViewEditorFile } from '../repo/centerView';
import { useToast } from '../ui/toastStore';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { row } from './testRows';

const fileHistory = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: { fileHistory, avatar: vi.fn(async () => null) }, errorMessage: (e: unknown) => String(e) }));
vi.mock('./BlameGutter', () => ({ BlameLayer: ({ row, onPick }: { row: { sha: string }; onPick(sha: string, g: boolean): void }) => <button type="button" data-testid="blame-stub" onClick={(e) => onPick(e.ctrlKey ? 'zz9999' : 'c3', e.altKey)}>{row.sha}</button> }));
const copyText = vi.hoisted(() => vi.fn(async (_t: string) => {}));
vi.mock('../api/transport', () => ({ copyText }));
const selectCommit = vi.hoisted(() => vi.fn(() => true));
vi.mock('../app/graphNav', () => ({ selectCommit }));
vi.mock('../diff/FileView', () => ({ FileView: ({ path, text }: { path: string; text: string }) => <pre data-testid="file-view" data-path={path}>{text}</pre> }));
// The hex panes (lane K), as stubs that say what they were given.
vi.mock('../diff/hex', async (orig) => ({
  ...(await orig<typeof import('../diff/hex')>()),
  HexView: ({ path, file, side }: { path: string; file: boolean; side?: { dump: string } | null }) => <pre data-testid="hex-view" data-path={path} data-mode={file ? 'file' : 'diff'}>{side?.dump}</pre>,
  HexBody: ({ target }: { target: { path: string; view: string } }) => <pre data-testid="hex-body" data-path={target.path} data-mode={target.view} />,
}));
const { FileHistory } = await import('./FileHistory');

const graph = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] } as unknown as GraphPayload;
const text = (t: string): DiffContentsPayload => ({ old: null, new: { size: t.length, binary: false, encoding: 'UTF-8', eol: 'lf', text: t, base64: null, hash: null }, tooLarge: false, eolOnly: false, image: false } as unknown as DiffContentsPayload);
const binarySide = { size: 4, binary: true, encoding: null, eol: null, text: null, base64: null, hash: null };
const contents = new Loader(async (k: string) => {
  const { path, new: side } = JSON.parse(k) as { path: string; new: { commit: string } };
  // A binary (its hex dumps load with it, hexContents.ts), and an image (they don't).
  if (path.endsWith('.bin')) return { old: null, new: binarySide, tooLarge: false, eolOnly: false, image: false, hex: { old: null, new: { dump: `${path} hex at ${side.commit}`, size: 4, cap: null } } } as unknown as DiffContentsPayload;
  if (path.endsWith('.png')) return { old: null, new: binarySide, tooLarge: false, eolOnly: false, image: true } as unknown as DiffContentsPayload;
  return text(`${path} at ${side.commit}`);
}, new Lru(10));
const args = { repoId: 1, worktree: '/r', path: 'src/story.txt', rev: null, blame: false };

function view(close = vi.fn()) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents }));
  render(<RepoViewContext value={store}><FileHistory tabId="t1" props={args} close={close} /></RepoViewContext>);
  return close;
}

describe('File History (spec #3 §4.2)', () => {
  beforeEach(() => fileHistory.mockReset());

  it('lists the commits newest first, shows the selected one\'s file, and ends with "Added in" and "End of history"', async () => {
    fileHistory.mockResolvedValueOnce({ rows: [row('a1'), row('b2', 'R'), row('c3', 'A', 'story.txt')], more: false } satisfies FileHistoryPage);
    view();
    expect(screen.getByRole('heading')).toHaveTextContent('File History: src/story.txt');
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(fileHistory).toHaveBeenCalledWith(1, '/r', 'src/story.txt', null, 0, 200);
    expect(await screen.findByTestId('file-view')).toHaveTextContent('src/story.txt at a1');
    // "Added in" names the commit with a copyable hash, like the rows' (UX: the user's follow-up).
    expect(screen.getByText(/^Added in/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Copy c3/ })).toHaveLength(2); // the row's and Added in's
    expect(screen.getByText('End of history')).toBeInTheDocument();
  });

  it('an older row shows the file at its own path; ↓ and ↑ move the selection', async () => {
    fileHistory.mockResolvedValueOnce({ rows: [row('a1'), row('c3', 'A', 'story.txt')], more: false });
    view();
    const options = await screen.findAllByRole('option');
    fireEvent.click(options[1]);
    expect(await screen.findByTestId('file-view')).toHaveTextContent('story.txt at c3');
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Commits' }), { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('takes the keyboard when it opens, and again when it shows after a file peeked over it', async () => {
    fileHistory.mockResolvedValue({ rows: [row('a1'), row('b2')], more: false });
    const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents }));
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const ui = (mode: 'visible' | 'hidden') => <RepoViewContext value={store}><Activity mode={mode}><FileHistory tabId="t1" props={args} close={vi.fn()} /></Activity></RepoViewContext>;
    const { rerender } = render(ui('visible'));
    const list = screen.getByRole('listbox', { name: 'Commits' });
    expect(document.activeElement).toBe(list);
    await screen.findAllByRole('option');
    // A file opened over it (the view hidden, the keyboard in the diff), then closed.
    rerender(ui('hidden'));
    outside.focus();
    rerender(ui('visible'));
    expect(document.activeElement).toBe(list);
    outside.remove();
  });

  it('opened for a file picked while sticky (`follow`, UX), it leaves the keyboard in the file list it was picked in', async () => {
    fileHistory.mockResolvedValue({ rows: [row('a1')], more: false });
    const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents }));
    const files = document.createElement('div');
    files.className = 'file-list';
    const listbox = files.appendChild(document.createElement('ul'));
    listbox.tabIndex = 0;
    document.body.append(files);
    listbox.focus();
    render(<RepoViewContext value={store}><FileHistory tabId="t1" props={{ ...args, follow: true }} close={vi.fn()} /></RepoViewContext>);
    await screen.findAllByRole('option');
    expect(document.activeElement).toBe(listbox);
    files.remove();
  });

  it('Load more asks for the rows after those loaded', async () => {
    fileHistory.mockResolvedValueOnce({ rows: [row('a1')], more: true }).mockResolvedValueOnce({ rows: [row('b2')], more: false });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(fileHistory).toHaveBeenLastCalledWith(1, '/r', 'src/story.txt', null, 1, 200);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a row that deleted the file says so instead of showing it', async () => {
    fileHistory.mockResolvedValueOnce({ rows: [row('d4', 'D')], more: false });
    view();
    expect(await screen.findByText('src/story.txt was deleted in this commit')).toBeInTheDocument();
    expect(screen.queryByTestId('file-view')).toBeNull();
    // No file shown: nothing for its editor's menu.
    expect(centerViewEditorFile('t1')).toBeNull();
  });

  it("its editor's menu target is the selected row's file at its commit, in the view's worktree", async () => {
    fileHistory.mockResolvedValueOnce({ rows: [row('a1'), row('c3', 'A', 'story.txt')], more: false });
    view();
    await screen.findByTestId('file-view');
    expect(centerViewEditorFile('t1')).toMatchObject({ target: { path: 'src/story.txt', new: { kind: 'atCommit', commit: 'a1' } }, root: '/r' });
    fireEvent.click(screen.getAllByRole('option')[1]);
    expect(centerViewEditorFile('t1')).toMatchObject({ target: { path: 'story.txt', new: { kind: 'atCommit', commit: 'c3' } }, root: '/r' });
  });

  it('a failed page says why, with Retry', async () => {
    fileHistory.mockRejectedValueOnce('boom').mockResolvedValueOnce({ rows: [row('a1')], more: false });
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the history: boom");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByRole('option')).toHaveLength(1);
  });

  it('Esc and × close it', async () => {
    fileHistory.mockResolvedValue({ rows: [row('a1')], more: false });
    const close = view();
    await screen.findAllByRole('option');
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close file history' }));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('the Blame toggle shows the gutter; its pick selects that commit in the list, Alt+click in the graph', async () => {
    fileHistory.mockResolvedValue({ rows: [row('a1'), row('b2'), row('c3', 'A')], more: false });
    const close = view();
    await screen.findAllByRole('option');
    expect(screen.queryByTestId('blame-stub')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Blame' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(await screen.findByTestId('blame-stub'));
    await waitFor(() => expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByTestId('blame-stub'), { altKey: true });
    expect(close).toHaveBeenCalled();
    expect(selectCommit).toHaveBeenCalledWith('t1', 'c3', { focus: true });
  });

  it('its Blame toggle sets the tab\'s sticky mode (UX): the next file opens as it was left', async () => {
    fileHistory.mockResolvedValue({ rows: [row('a1')], more: false });
    const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents }));
    useTabViews.setState({ views: { t1: { repo: 1, services: store.getState().services, store } } });
    store.getState().setStickyHistory({ blame: false });
    render(<RepoViewContext value={store}><FileHistory tabId="t1" props={args} close={vi.fn()} /></RepoViewContext>);
    await screen.findAllByRole('option');
    fireEvent.click(screen.getByRole('button', { name: 'Blame' }));
    expect(store.getState().stickyHistory).toEqual({ blame: true });
    fireEvent.click(screen.getByRole('button', { name: 'Blame' }));
    expect(store.getState().stickyHistory).toEqual({ blame: false });
    useTabViews.setState({ views: {} });
  });

  it('a blame pick outside the file\'s history, or outside the loaded graph, says so', async () => {
    fileHistory.mockResolvedValue({ rows: [row('a1'), row('c3', 'A')], more: false });
    view();
    await screen.findAllByRole('option');
    fireEvent.click(screen.getByRole('button', { name: 'Blame' }));
    fireEvent.click(await screen.findByTestId('blame-stub'), { ctrlKey: true });
    await waitFor(() => expect(useToast.getState().message).toBe("zz9999 isn't in this file's history"));
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    selectCommit.mockReturnValueOnce(false);
    fireEvent.click(screen.getByTestId('blame-stub'), { altKey: true });
    expect(useToast.getState().message).toBe('Not in the loaded history');
  });

  it('a binary shows File View\'s hex panes at the commit, not a placeholder, and its Blame toggle is disabled, in place (lane K)', async () => {
    fileHistory.mockResolvedValue({ rows: [row('a1', 'M', 'data/blob.bin'), row('b2', 'M', 'data/pic.png'), row('c3', 'A')], more: false });
    const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents }));
    // Opened as Blame (the diff toolbar's button): the binary still shows, with no blame over it.
    render(<RepoViewContext value={store}><FileHistory tabId="t1" props={{ ...args, path: 'data/blob.bin', blame: true }} close={vi.fn()} /></RepoViewContext>);
    const hex = await screen.findByTestId('hex-view');
    expect(hex).toHaveAttribute('data-mode', 'file');
    expect(hex).toHaveTextContent('data/blob.bin hex at a1');
    expect(screen.queryByText(/no text to show/)).toBeNull();
    expect(screen.queryByTestId('blame-stub')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Blame' })).toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByRole('button', { name: 'Blame' })).toHaveAttribute('aria-pressed', 'false');
    // An image's dumps load on their own (HexBody), in File View too.
    fireEvent.click(screen.getAllByRole('option')[1]);
    expect(await screen.findByTestId('hex-body')).toHaveAttribute('data-mode', 'file');
    expect(screen.getByRole('button', { name: 'Blame' })).toHaveAttribute('aria-disabled', 'true');
    // A text file: the file, the toggle and the blame are back.
    fireEvent.click(screen.getAllByRole('option')[2]);
    expect(await screen.findByTestId('file-view')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Blame' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('blame-stub')).toBeInTheDocument();
  });

  it('clicking a short hash copies the full one without selecting the row; resizing persists the list width', async () => {
    localStorage.clear();
    fileHistory.mockResolvedValue({ rows: [row('c3aaaaaaaa'), row('c2bbbbbbbb')], more: false });
    view();
    const opts = await screen.findAllByRole('option');
    const selected = opts.map((o) => o.getAttribute('aria-selected'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy c2bbbbbbbb' }));
    expect(opts.map((o) => o.getAttribute('aria-selected'))).toEqual(selected);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('c2bbbbbbbb'));
    const sep = screen.getByRole('separator', { name: 'Resize commit list' });
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(sep).toHaveAttribute('aria-valuenow', '376');
    expect(localStorage.getItem('gitbolt.historyListWidth.v1')).toBe('376');
    expect(screen.getByRole('region', { name: 'File history' }).style.getPropertyValue('--fh-list')).toBe('376px');
    fireEvent.keyDown(sep, { key: 'End' });
    expect(sep).toHaveAttribute('aria-valuenow', '640');
  });
});
