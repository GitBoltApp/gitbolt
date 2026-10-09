import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobSource } from '../api/gen/BlobSource';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { FileHistoryRow } from '../api/gen/FileHistoryRow';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { DEFAULT_DIFF_PREFS, DIFF_PREFS_STORAGE_KEY, useDiffPrefs } from '../diff/diffPrefs';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { row } from './testRows';

const fileHistory = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: { fileHistory, avatar: vi.fn(async () => null) }, errorMessage: (e: unknown) => String(e) }));
vi.mock('./BlameGutter', () => ({ BlameLayer: () => <div data-testid="blame-stub" /> }));
vi.mock('../diff/FileView', () => ({ FileView: ({ path, text }: { path: string; text: string }) => <pre data-testid="file-view" data-path={path}>{text}</pre> }));
// The diff editor: what it's given, and how many times it mounted (it stays from row to row).
const mounts = vi.hoisted(() => ({ n: 0 }));
vi.mock('../diff/TextDiff', async () => {
  const { useEffect } = await import('react');
  return {
    loadedHost: () => null,
    TextDiff: ({ identity, original, modified }: { identity: string; original: string; modified: string }) => {
      useEffect(() => { mounts.n++; }, []);
      return <pre data-testid="text-diff" data-identity={identity} data-original={original}>{modified}</pre>;
    },
  };
});
vi.mock('../diff/monaco/load', () => ({ loadMonacoHost: async () => ({ goToChange: vi.fn() }) }));
vi.mock('../markdown/fileLinks', () => ({}));
vi.mock('../markdown/lazy', () => ({
  Markdown: () => null,
  MarkdownDiff: ({ old, new: neu, context, oldContext }: { old: string; new: string; context: { commit: string }; oldContext: { commit: string } }) => (
    <div data-testid="md-diff" data-old={old} data-commit={context.commit} data-old-commit={oldContext.commit}>{neu}</div>
  ),
}));
vi.mock('../diff/hex', async (orig) => ({
  ...(await orig<typeof import('../diff/hex')>()),
  HexView: ({ path, file }: { path: string; file: boolean }) => <pre data-testid="hex-view" data-path={path} data-mode={file ? 'file' : 'diff'} />,
}));
const { FileHistory } = await import('./FileHistory');

const graph = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] } as unknown as GraphPayload;
const P0 = 'p0';
const side = (path: string, s: BlobSource) => (s.kind === 'atCommit' ? `${path}@${s.commit}` : s.kind === 'object' ? `${path}#${s.oid}` : null);
const blob = (text: string) => ({ size: text.length, binary: false, encoding: 'UTF-8', eol: 'lf', text, base64: null, hash: null });
const contents = new Loader(async (k: string) => {
  const { path, old, new: neu } = JSON.parse(k) as { path: string; old: BlobSource; new: BlobSource };
  if (path.endsWith('.bin')) {
    const bin = { size: 4, binary: true, encoding: null, eol: null, text: null, base64: null, hash: null };
    return { old: bin, new: bin, tooLarge: false, eolOnly: false, image: false, hex: { old: { dump: 'o', size: 4, cap: null }, new: { dump: 'n', size: 4, cap: null } } } as unknown as DiffContentsPayload;
  }
  const o = side(path, old);
  const n = side(path, neu);
  return { old: o === null ? null : blob(o), new: n === null ? null : blob(n), tooLarge: false, eolOnly: false, image: false } as unknown as DiffContentsPayload;
}, new Lru(50));
const fileList = vi.fn(async (_k: string): Promise<FileListPayload> => ({ files: [], added: 0, deleted: 0 }));
const files = new Loader((k: string) => fileList(k), new Lru(10));
const args = { repoId: 1, worktree: '/r', path: 'src/story.txt', rev: null, blame: false };
const withParent = (r: FileHistoryRow, ...parents: string[]): FileHistoryRow => ({ ...r, parents: parents.length ? parents : [P0] });

function view(path = args.path) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents, files }));
  return render(<RepoViewContext value={store}><FileHistory tabId="t1" props={{ ...args, path }} close={vi.fn()} /></RepoViewContext>);
}
const toggle = () => screen.getByRole('group', { name: 'History view' });
const pick = (name: 'File' | 'Changes') => fireEvent.click(within(toggle()).getByRole('button', { name }));

describe('File History: File | Changes', () => {
  beforeEach(() => {
    fileHistory.mockReset();
    localStorage.clear();
    useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS });
    mounts.n = 0;
  });

  it('opens on File; Changes shows the diff the commit made, and the pick is remembered', async () => {
    fileHistory.mockResolvedValue({ rows: [withParent(row('a1'), 'b2'), withParent(row('b2'))], more: false });
    const first = view();
    expect(await screen.findByTestId('file-view')).toHaveTextContent('src/story.txt@a1');
    expect(within(toggle()).getByRole('button', { name: 'File' })).toHaveAttribute('aria-pressed', 'true');
    pick('Changes');
    expect(within(toggle()).getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-pressed', 'true');
    const diff = await screen.findByTestId('text-diff');
    expect(diff).toHaveAttribute('data-original', 'src/story.txt@b2');
    expect(diff).toHaveTextContent('src/story.txt@a1');
    expect(screen.queryByTestId('file-view')).toBeNull();
    expect(JSON.parse(localStorage.getItem(DIFF_PREFS_STORAGE_KEY)!)).toMatchObject({ historyView: 'changes' });
    // Diff View's toolbar: its view modes apply here.
    expect(screen.getByRole('button', { name: 'Split' })).toBeEnabled();
    // The next history opens on Changes.
    first.unmount();
    view();
    expect(await screen.findByTestId('text-diff')).toBeInTheDocument();
    pick('File');
    expect(await screen.findByTestId('file-view')).toBeInTheDocument();
    expect(useDiffPrefs.getState().prefs.historyView).toBe('file');
  });

  it('↑/↓ keep Changes and move the diff, in the same editor', async () => {
    useDiffPrefs.getState().set({ historyView: 'changes' });
    fileHistory.mockResolvedValue({ rows: [withParent(row('a1'), 'b2'), withParent(row('b2'), 'c3'), withParent(row('c3', 'A'))], more: false });
    view();
    expect(await screen.findByTestId('text-diff')).toHaveTextContent('src/story.txt@a1');
    const list = screen.getByRole('listbox', { name: 'Commits' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByTestId('text-diff')).toHaveTextContent('src/story.txt@b2'));
    expect(screen.getByTestId('text-diff')).toHaveAttribute('data-original', 'src/story.txt@c3');
    // The add: all added.
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByTestId('text-diff')).toHaveTextContent('src/story.txt@c3'));
    expect(screen.getByTestId('text-diff')).toHaveAttribute('data-original', '');
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    await waitFor(() => expect(screen.getByTestId('text-diff')).toHaveTextContent('src/story.txt@b2'));
    expect(within(toggle()).getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-pressed', 'true');
    expect(mounts.n).toBe(1);
  });

  it('a deleted row shows the deletion; a rename\'s old side is its commit\'s entry, at the old path', async () => {
    useDiffPrefs.getState().set({ historyView: 'changes' });
    fileList.mockImplementation(async () => ({ files: [{ path: 'src/story.txt', oldPath: 'story.txt', status: 'R', additions: 1, deletions: 1, old: { kind: 'object', oid: 'old1' }, new: { kind: 'object', oid: 'new1' }, submodule: false }], added: 1, deleted: 1 }));
    fileHistory.mockResolvedValue({ rows: [withParent(row('d4', 'D'), 'r1'), { ...withParent(row('r1', 'R')), oldPath: 'story.txt' }], more: false });
    view();
    const diff = await screen.findByTestId('text-diff');
    expect(diff).toHaveAttribute('data-original', 'src/story.txt@r1');
    expect(diff).toHaveTextContent(/^$/);
    expect(screen.queryByText(/was deleted in this commit/)).toBeNull();
    fireEvent.click(screen.getAllByRole('option')[1]);
    await waitFor(() => expect(screen.getByTestId('text-diff')).toHaveTextContent('src/story.txt#new1'));
    expect(screen.getByTestId('text-diff')).toHaveAttribute('data-original', 'src/story.txt#old1');
    expect(fileList).toHaveBeenCalledWith(JSON.stringify({ kind: 'commit', id: 'r1', parent: 0 }));
  });

  it('a merge row is against its first parent', async () => {
    useDiffPrefs.getState().set({ historyView: 'changes' });
    fileList.mockImplementation(async () => ({ files: [], added: 0, deleted: 0 }));
    fileHistory.mockResolvedValue({ rows: [withParent(row('m1', ''), 'first', 'second')], more: false });
    view();
    const diff = await screen.findByTestId('text-diff');
    expect(diff).toHaveAttribute('data-original', 'src/story.txt@first');
    expect(diff).toHaveTextContent('src/story.txt@m1');
    expect(fileList).toHaveBeenCalledWith(JSON.stringify({ kind: 'commit', id: 'm1', parent: 0 }));
  });

  it('a Markdown file shows the rendered diff by default, its sides at the commit and its parent', async () => {
    useDiffPrefs.getState().set({ historyView: 'changes' });
    fileHistory.mockResolvedValue({ rows: [withParent(row('a1', 'M', 'docs/guide.md'), 'b2')], more: false });
    view('docs/guide.md');
    const md = await screen.findByTestId('md-diff');
    expect(md).toHaveTextContent('docs/guide.md@a1');
    expect(md).toHaveAttribute('data-old', 'docs/guide.md@b2');
    expect(md).toHaveAttribute('data-commit', 'a1');
    expect(md).toHaveAttribute('data-old-commit', 'b2');
    const md2 = screen.getByRole('group', { name: 'Markdown view' });
    expect(within(md2).getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(md2).getByRole('button', { name: 'Source' }));
    await waitFor(() => expect(screen.getByTestId('markdown-diff')).not.toBeVisible());
  });

  it('a binary shows the hex diff', async () => {
    useDiffPrefs.getState().set({ historyView: 'changes' });
    fileHistory.mockResolvedValue({ rows: [withParent(row('a1', 'M', 'data/blob.bin'))], more: false });
    view('data/blob.bin');
    expect(await screen.findByTestId('hex-view')).toHaveAttribute('data-mode', 'diff');
  });

  it('Blame is off in Changes, in place, saying why; back on File it shows again', async () => {
    fileHistory.mockResolvedValue({ rows: [withParent(row('a1'))], more: false });
    view();
    await screen.findByTestId('file-view');
    const blame = screen.getByRole('button', { name: 'Blame' });
    fireEvent.click(blame);
    expect(await screen.findByTestId('blame-stub')).toBeInTheDocument();
    pick('Changes');
    await screen.findByTestId('text-diff');
    expect(blame).toHaveAttribute('aria-disabled', 'true');
    expect(blame).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('blame-stub')).toBeNull();
    fireEvent.click(blame);
    pick('File');
    expect(await screen.findByTestId('blame-stub')).toBeInTheDocument();
    expect(blame).toHaveAttribute('aria-pressed', 'true');
  });
});
