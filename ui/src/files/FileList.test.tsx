import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
import { rowIndent } from './fileTree';
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
    // F19: coloured status icons with their numbers, named for assistive tech.
    const counts = screen.getByTestId('file-counts');
    expect(counts).toHaveAccessibleName('2 modified · 1 renamed');
    expect([...counts.querySelectorAll('svg')].map((i) => i.dataset.status)).toEqual(['modified', 'renamed']);
    expect(counts).toHaveTextContent(/^21$/);
    expect(screen.getByTestId('file-totals')).toHaveTextContent('+4 −2');
    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveTextContent('docs/guide.txt → docs/manual.txt');
    // F17: an icon per status, no A/M/D letter.
    expect(within(rows[0]).getByRole('img', { name: 'Renamed' }).tagName.toLowerCase()).toBe('svg');
    expect(within(rows[2]).getByRole('img', { name: 'Modified' })).toHaveAttribute('data-status', 'modified');
    expect(within(rows[2]).queryByText('M')).toBeNull();
    expect(rows[2].querySelector('.status-badge')).toBeNull();
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

  it('tree mode: no folder icons, and each file\'s icon starts where its folder\'s name does (F17)', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const opt = (path: string) => screen.getAllByRole('option').find((r) => r.dataset.path === path)!;
    expect(opt('docs').querySelector('.lucide-folder')).toBeNull();
    expect(opt('docs').querySelectorAll('svg')).toHaveLength(1); // the chevron only
    expect(opt('docs')).toHaveStyle({ paddingLeft: `${rowIndent(0)}px` });
    expect(opt('docs/manual.txt')).toHaveStyle({ paddingLeft: `${rowIndent(1)}px` });
    expect(opt('logo.png')).toHaveStyle({ paddingLeft: `${rowIndent(0)}px` });
  });

  it('a collapsed folder shows its change counts; an expanded one doesn\'t (F20)', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const opt = (path: string) => screen.getAllByRole('option').find((r) => r.dataset.path === path)!;
    expect(within(opt('docs')).queryByTestId('folder-counts')).toBeNull();
    fireEvent.mouseDown(opt('docs'));
    const counts = within(opt('docs')).getByTestId('folder-counts');
    expect(counts).toHaveAccessibleName('1 renamed');
    expect([...counts.querySelectorAll('svg')].map((i) => i.dataset.status)).toEqual(['renamed']);
    expect(counts).toHaveTextContent(/^1$/);
  });

  it('the toolbar: one smart Expand/Collapse button on the left, Path/Tree in the centre, View all files on the right (F18)', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const toolbar = screen.getByRole('toolbar', { name: 'File list options' });
    const names = () => within(toolbar).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names()).toEqual(['Collapse all', 'Path', 'Tree', 'View all files']);
    const slots = [...toolbar.children].map((c) => c.className);
    expect(slots).toEqual(['file-toolbar-start', 'file-toolbar-center', 'file-toolbar-end']);
    // Everything expanded: the button collapses everything, then offers to expand.
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Collapse all' }));
    expect(screen.getAllByRole('option').filter((r) => r.dataset.kind === 'folder').every((r) => r.getAttribute('aria-expanded') === 'false')).toBe(true);
    const expand = within(toolbar).getByRole('button', { name: 'Expand all' });
    expect(within(toolbar).queryByRole('button', { name: 'Collapse all' })).toBeNull();
    fireEvent.click(expand);
    expect(screen.getAllByRole('option').filter((r) => r.dataset.kind === 'folder').every((r) => r.getAttribute('aria-expanded') === 'true')).toBe(true);
    // Only some collapsed: it expands all.
    fireEvent.mouseDown(screen.getAllByRole('option').find((r) => r.dataset.path === 'docs')!);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByRole('option').find((r) => r.dataset.path === 'docs')).toHaveAttribute('aria-expanded', 'true');
    expect(within(toolbar).getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
    // Path and Tree carry icons; Path mode puts Sort by status in the left slot.
    expect(within(toolbar).getByRole('button', { name: 'Path' }).querySelector('svg')).not.toBeNull();
    expect(within(toolbar).getByRole('button', { name: 'Tree' }).querySelector('svg')).not.toBeNull();
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Path' }));
    expect(names()).toEqual(['Sort by status', 'Path', 'Tree', 'View all files']);
  });

  it('counts conflicted (U/X) files in the header and in collapsed folders (review fix)', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const withConflict = { files: [change('src/app.php'), change('src/merge.php', 'U')], added: 1, deleted: 0 };
    render(<RepoViewContext value={store}><FileList list={withConflict} spec={spec} label="Changed files" /></RepoViewContext>);
    const counts = screen.getByTestId('file-counts');
    expect(counts).toHaveAccessibleName('1 modified · 1 conflicted');
    expect([...counts.querySelectorAll('svg')].map((i) => i.dataset.status)).toEqual(['modified', 'conflicted']);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(within(screen.getAllByRole('option')[0]).getByTestId('folder-counts')).toHaveAccessibleName('1 modified · 1 conflicted');
    expect(within(screen.getAllByRole('option')[0]).queryByRole('img', { name: 'Unmerged' })).toBeNull(); // folder icons are decorative
  });
});

