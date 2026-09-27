import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import type { RepoServices } from '../repo/services';
import { contentKey } from '../repo/services';
import { contentsRequest, createRepoViewStore, RepoViewContext, targetFor } from '../repo/store';
import { fakeServices, recordingServices } from '../repo/testServices';
import { FILE_ROW_H, FileList } from './FileList';
import { useFileListPrefs } from './fileListPrefs';

const change = (path: string, status = 'M', additions: number | null = 2): FileChange => ({
  path, oldPath: status === 'R' ? 'docs/guide.txt' : null, status, additions, deletions: additions === null ? null : 1,
  old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, submodule: false,
});
const list = { files: [change('docs/manual.txt', 'R'), change('logo.png', 'M', null), change('src/app.php')], added: 4, deleted: 2 };
const spec = { kind: 'commit' as const, id: 'c'.repeat(40), parent: 0 };
const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false };

function setup(services: RepoServices = fakeServices({ treeFiles: new Loader(async () => ['docs/manual.txt', 'logo.png', 'src/app.php', 'zzz.txt'], new Lru(2)) })) {
  const store = createRepoViewStore(1, '/r', graph, services);
  render(<RepoViewContext value={store}><FileList list={list} spec={spec} label="Changed files" allFilesCommit={spec.id} /></RepoViewContext>);
  return store;
}

describe('FileList', () => {
  it('shows counts, renames, binary stats, and opens files with Up/Down', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    expect(screen.getByTestId('file-counts')).toHaveTextContent('2 modified · 1 renamed');
    expect(screen.getByTestId('file-counts')).not.toHaveTextContent('added');
    expect(screen.getByTestId('file-totals')).toHaveTextContent('+4 −2');
    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveTextContent('docs/guide.txt → docs/manual.txt');
    expect(rows[1]).toHaveAttribute('title', 'binary');
    fireEvent.mouseDown(rows[0]);
    expect(store.getState().diff?.path).toBe('docs/manual.txt');
    const box = screen.getByRole('listbox', { name: 'Changed files' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(store.getState().diff?.path).toBe('logo.png');
    fireEvent.keyDown(box, { key: 'End' });
    expect(store.getState().diff?.path).toBe('src/app.php');
  });

  it('tree mode toggles folders with clicks and arrow keys', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const docs = screen.getAllByRole('option').find((r) => r.dataset.path === 'docs')!;
    expect(docs).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseDown(docs);
    expect(screen.getAllByRole('option').find((r) => r.dataset.path === 'docs')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowRight' });
    expect(screen.getAllByRole('option').find((r) => r.dataset.path === 'docs')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.getAllByRole('option').every((r) => r.dataset.kind === 'folder' || r.dataset.path === 'logo.png')).toBe(true);
  });

  it('View all files lists unchanged files from the commit tree', async () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: true });
    setup();
    expect(await screen.findByText('zzz.txt')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('opening a file prefetches the contents of the files on either side', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const rec = recordingServices();
    setup(rec.services);
    fireEvent.mouseDown(screen.getAllByRole('option')[1]);
    const key = (path: string) => `contents ${contentKey(contentsRequest(targetFor(list.files.find((f) => f.path === path)!, spec)))}`;
    expect(rec.calls).toEqual([key('docs/manual.txt'), key('src/app.php')]);
  });

  it('rows are 24 px, and ← / → move between the graph, the files and an open diff', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    const rows = screen.getAllByRole('option');
    expect(FILE_ROW_H).toBe(24);
    expect(rows[1]).toHaveStyle({ height: '24px', top: '24px' });
    const box = screen.getByRole('listbox');
    fireEvent.mouseDown(rows[0]);
    act(() => store.getState().setFocus('files'));
    fireEvent.keyDown(box, { key: 'ArrowLeft' }); // a diff is open (the graph is hidden): stay
    expect(store.getState().focus).toBe('files');
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(store.getState().focus).toBe('diff');
    act(() => {
      store.getState().closeDiff();
      store.getState().setFocus('files');
    });
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(store.getState().focus).toBe('graph');
  });

  it('Esc, then Enter, highlights the opened file: the cursor belongs to the diff it was set for', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    fireEvent.mouseDown(screen.getAllByRole('option')[2]);
    expect(store.getState().diff?.path).toBe('src/app.php');
    act(() => store.getState().closeDiff());
    // Enter in the graph: openFirstFile opens the first file.
    act(() => store.getState().openFile(targetFor(list.files[0], spec)));
    const rows = screen.getAllByRole('option');
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    expect(store.getState().diff?.path).toBe('logo.png');
  });

  it('tree ←/→ on the open file\'s folder with a diff open collapse and expand it, keeping the cursor there', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    const store = setup();
    const box = screen.getByRole('listbox');
    const opt = (path: string) => screen.getAllByRole('option').find((r) => r.dataset.path === path);
    fireEvent.mouseDown(opt('docs/manual.txt')!);
    act(() => store.getState().setFocus('files'));
    fireEvent.keyDown(box, { key: 'ArrowUp' }); // onto the folder: nothing new opens
    expect(store.getState().diff?.path).toBe('docs/manual.txt');
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(opt('docs')).toHaveAttribute('aria-expanded', 'false');
    expect(opt('docs')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(opt('docs')).toHaveAttribute('aria-expanded', 'true');
    expect(store.getState().focus).toBe('files'); // expanded, didn't leave for the diff
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(store.getState().diff?.path).toBe('docs/manual.txt');
    expect(opt('docs/manual.txt')).toHaveAttribute('aria-selected', 'true');
    // Collapse all hides the open file: its folder row takes the cursor.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(opt('docs')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(opt('docs')).toHaveAttribute('aria-expanded', 'true');
    expect(opt('docs')).toHaveAttribute('aria-selected', 'true'); // the cursor stays on the folder
    expect(opt('docs/manual.txt')).toHaveAttribute('aria-selected', 'false');
  });

  it('the listbox points aria-activedescendant at the active option', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    setup();
    const box = screen.getByRole('listbox');
    expect(box).not.toHaveAttribute('aria-activedescendant');
    fireEvent.mouseDown(screen.getAllByRole('option')[1]);
    const active = screen.getAllByRole('option')[1];
    expect(active.id).not.toBe('');
    expect(box).toHaveAttribute('aria-activedescendant', active.id);
    expect(new Set(screen.getAllByRole('option').map((o) => o.id)).size).toBe(3);
  });

  it('a failed View all files load shows an error row with a retry', async () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: true });
    let fail = true;
    setup(fakeServices({ treeFiles: new Loader(async () => { if (fail) throw new Error('tree walk failed'); return ['zzz.txt']; }, new Lru(2)) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('tree walk failed');
    expect(screen.getAllByRole('option')).toHaveLength(3); // the changed files are still listed
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('zzz.txt')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
