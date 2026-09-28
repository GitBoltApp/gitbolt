import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import type { RepoServices } from '../repo/services';
import { contentKey } from '../repo/services';
import { contentsRequest, createRepoViewStore, RepoViewContext, targetFor } from '../repo/store';
import { fakeServices, recordingServices } from '../repo/testServices';
import { DEFAULT_DENSITY, DENSITIES, DENSITY_METRICS, useDensity } from '../theme/density';
import { FileList } from './FileList';
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
  beforeEach(() => useDensity.setState({ density: DEFAULT_DENSITY }));

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
    // H22: a rename shows its new path; the old one is in the row's tooltip.
    expect(rows[0]).toHaveTextContent('docs/manual.txt');
    expect(rows[0]).not.toHaveTextContent('guide');
    // F17: an icon per status, no A/M/D letter.
    expect(within(rows[0]).getByRole('img', { name: 'Renamed' }).tagName.toLowerCase()).toBe('svg');
    expect(within(rows[2]).getByRole('img', { name: 'Modified' })).toHaveAttribute('data-status', 'modified');
    expect(within(rows[2]).queryByText('M')).toBeNull();
    expect(rows[2].querySelector('.status-badge')).toBeNull();
    expect(rows[1]).toHaveTextContent('binary');
    expect(rows[1]).not.toHaveAttribute('title');
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

  it("rows are the density preset's height, following a change (H1)", () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    setup();
    for (const d of DENSITIES) {
      act(() => useDensity.setState({ density: d }));
      const h = DENSITY_METRICS[d].fileRowH;
      expect(screen.getAllByRole('option')[2], d).toHaveStyle({ height: `${h}px`, top: `${2 * h}px` });
    }
    // The default, standard, is taller than 1B's fixed 24 px; compact keeps it.
    expect(DENSITY_METRICS[DEFAULT_DENSITY].fileRowH).toBe(26);
    expect(DENSITY_METRICS.compact.fileRowH).toBe(24);
  });

  it('J2: → opens the active file (nothing if it is open); ← closes the diff and returns to the graph', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    const rows = () => screen.getAllByRole('option');
    const box = screen.getByRole('listbox');
    fireEvent.mouseDown(rows()[0]);
    act(() => store.getState().setFocus('files'));
    const open = store.getState().diff;
    const request = store.getState().focusRequest;
    fireEvent.keyDown(box, { key: 'ArrowRight' }); // already open: nothing
    expect(store.getState().diff).toBe(open);
    expect(store.getState().focus).toBe('files');
    expect(store.getState().focusRequest).toBe(request);
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(store.getState().diff).toBeNull();
    expect(store.getState().focus).toBe('graph');
    // Closed with its own toggle, the row keeps the cursor: → opens it again.
    act(() => store.getState().setFocus('files'));
    fireEvent.mouseDown(rows()[1]);
    fireEvent.mouseDown(rows()[1]);
    expect(store.getState().diff).toBeNull();
    expect(fireEvent.keyDown(box, { key: 'ArrowRight' })).toBe(false);
    expect(store.getState().diff?.path).toBe('logo.png');
    // ← with no diff open still returns to the graph.
    fireEvent.mouseDown(rows()[1]);
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(store.getState().focus).toBe('graph');
  });

  it('J2: ← on an expanded folder collapses it and → on a collapsed one expands it; ← on any other row closes the diff', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    const store = setup();
    const box = screen.getByRole('listbox');
    const opt = (path: string) => screen.getAllByRole('option').find((r) => r.dataset.path === path)!;
    fireEvent.mouseDown(opt('src/app.php'));
    fireEvent.mouseDown(opt('docs')); // collapses it; the cursor is on the folder
    act(() => store.getState().setFocus('files'));
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(opt('docs')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(box, { key: 'ArrowRight' }); // an expanded folder: on to its first child, opened
    expect(opt('docs')).toHaveAttribute('aria-expanded', 'true');
    expect(opt('docs/manual.txt')).toHaveAttribute('aria-selected', 'true');
    expect(store.getState().diff?.path).toBe('docs/manual.txt');
    fireEvent.mouseDown(opt('src/app.php'));
    fireEvent.mouseDown(opt('docs'));
    fireEvent.mouseDown(opt('docs')); // the cursor on the expanded folder again
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(opt('docs')).toHaveAttribute('aria-expanded', 'false');
    expect(opt('docs')).toHaveAttribute('aria-selected', 'true');
    expect(store.getState().focus).toBe('files');
    // A collapsed folder: ← leaves, closing the diff.
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(store.getState().diff).toBeNull();
    expect(store.getState().focus).toBe('graph');
    // A file inside an expanded folder: ← closes the diff too (it doesn't climb to the folder).
    fireEvent.mouseDown(opt('docs'));
    fireEvent.mouseDown(opt('docs/manual.txt'));
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(store.getState().diff).toBeNull();
    expect(opt('docs')).toHaveAttribute('aria-expanded', 'true');
  });

  it('J3: Up/Down, Home/End and PgUp/PgDn move between files only, skipping folder rows, and open each', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    const store = setup();
    const box = screen.getByRole('listbox');
    const opt = (path: string) => screen.getAllByRole('option').find((r) => r.dataset.path === path)!;
    const key = (k: string) => fireEvent.keyDown(box, { key: k });
    const open = () => store.getState().diff?.path;
    // Rows: docs/, manual.txt, src/, app.php, logo.png.
    expect(screen.getAllByRole('option').map((r) => r.dataset.kind)).toEqual(['folder', 'file', 'folder', 'file', 'file']);
    key('ArrowDown'); // nothing active yet: the first file
    expect(open()).toBe('docs/manual.txt');
    key('ArrowDown');
    expect(open()).toBe('src/app.php');
    expect(opt('src/app.php')).toHaveAttribute('aria-selected', 'true');
    key('ArrowDown');
    expect(open()).toBe('logo.png');
    key('ArrowDown'); // the last file: stays
    expect(open()).toBe('logo.png');
    key('ArrowUp');
    expect(open()).toBe('src/app.php');
    key('ArrowUp');
    expect(open()).toBe('docs/manual.txt');
    key('ArrowUp'); // the first file: stays, never on the folder above it
    expect(open()).toBe('docs/manual.txt');
    expect(opt('docs')).toHaveAttribute('aria-selected', 'false');
    key('End');
    expect(open()).toBe('logo.png');
    key('Home');
    expect(open()).toBe('docs/manual.txt');
    key('PageDown');
    expect(open()).toBe('logo.png');
    key('PageUp');
    expect(open()).toBe('docs/manual.txt');
    // From a folder row (a click put the cursor there): the next file after it, or before it.
    fireEvent.mouseDown(opt('src'));
    fireEvent.mouseDown(opt('src'));
    expect(opt('src')).toHaveAttribute('aria-selected', 'true');
    key('ArrowDown');
    expect(open()).toBe('src/app.php');
    fireEvent.mouseDown(opt('src'));
    key('ArrowUp');
    expect(open()).toBe('docs/manual.txt');
    // src/ is collapsed now: its files aren't rows, so Down skips to the next visible file.
    expect(opt('src')).toHaveAttribute('aria-expanded', 'false');
    key('ArrowDown');
    expect(open()).toBe('logo.png');
  });

  it('J3: PgUp/PgDn step a page of rows and land on a file, never a folder', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    // Folders a/ … f/ with one file each: rows alternate folder, file.
    const many = { files: 'abcdef'.split('').map((d) => change(`${d}/x.txt`)), added: 6, deleted: 0 };
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    render(<RepoViewContext value={store}><FileList list={many} spec={spec} label="Changed files" /></RepoViewContext>);
    const box = screen.getByRole('listbox');
    // jsdom has no layout: a 4-row viewport makes a page 3 rows, so every step lands on a folder.
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 4 * DENSITY_METRICS[DEFAULT_DENSITY].fileRowH });
    const key = (k: string) => fireEvent.keyDown(box, { key: k });
    key('Home');
    expect(store.getState().diff?.path).toBe('a/x.txt'); // row 1
    key('PageDown'); // row 4 is c/: on to its file
    expect(store.getState().diff?.path).toBe('c/x.txt');
    key('PageUp'); // row 2 is b/: back to the file before it
    expect(store.getState().diff?.path).toBe('a/x.txt');
    key('End');
    expect(store.getState().diff?.path).toBe('f/x.txt'); // row 11
    key('PageUp'); // row 8 is e/
    expect(store.getState().diff?.path).toBe('d/x.txt');
    key('PageDown'); // from row 7, row 10 is f/
    expect(store.getState().diff?.path).toBe('f/x.txt');
    key('PageDown'); // past the end: the last file
    expect(store.getState().diff?.path).toBe('f/x.txt');
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
    // Onto the folder (a click collapses it; a second expands it again): nothing new opens.
    fireEvent.mouseDown(opt('docs')!);
    fireEvent.mouseDown(opt('docs')!);
    expect(store.getState().diff?.path).toBe('docs/manual.txt');
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(opt('docs')).toHaveAttribute('aria-expanded', 'false');
    expect(opt('docs')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(opt('docs')).toHaveAttribute('aria-expanded', 'true');
    expect(store.getState().focus).toBe('files');
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

  it('clicking the open file closes it, and Enter/Space toggle the active file (H5b)', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    const box = screen.getByRole('listbox');
    const row = () => screen.getAllByRole('option')[2];
    fireEvent.mouseDown(row());
    expect(store.getState().diff?.path).toBe('src/app.php');
    act(() => store.getState().setFocus('files'));
    fireEvent.mouseDown(row());
    expect(store.getState().diff).toBeNull();
    // The row keeps the cursor, and the keyboard stays in the file list.
    expect(box).toHaveAttribute('aria-activedescendant', row().id);
    expect(store.getState().focus).toBe('files');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(store.getState().diff?.path).toBe('src/app.php');
    fireEvent.keyDown(box, { key: ' ' });
    expect(store.getState().diff).toBeNull();
    fireEvent.keyDown(box, { key: ' ' });
    expect(store.getState().diff?.path).toBe('src/app.php');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(store.getState().diff).toBeNull();
    // A right-button press never toggles.
    fireEvent.mouseDown(row());
    fireEvent.mouseDown(row(), { button: 2 });
    expect(store.getState().diff?.path).toBe('src/app.php');
  });

  it('a double-click doesn\'t toggle the file straight back (fix round 1)', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    const row = () => screen.getAllByRole('option')[2];
    fireEvent.mouseDown(row(), { detail: 1 });
    fireEvent.mouseDown(row(), { detail: 2 });
    expect(store.getState().diff?.path).toBe('src/app.php');
  });

  it('with two lists (WIP), only the list that closed its file keeps a highlighted row (fix round 1)', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const wip = (staged: boolean) => ({ kind: 'wip' as const, worktree: '/r', staged });
    render(
      <RepoViewContext value={store}>
        <FileList list={list} spec={wip(false)} label="Unstaged" />
        <FileList list={list} spec={wip(true)} label="Staged" />
      </RepoViewContext>,
    );
    const rows = (label: string) => within(screen.getByRole('listbox', { name: label })).getAllByRole('option');
    const selected = () => screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => `${o.closest('[role="listbox"]')!.getAttribute('aria-label')} ${o.dataset.path}`);
    fireEvent.mouseDown(rows('Unstaged')[0]);
    fireEvent.mouseDown(rows('Unstaged')[0]); // closed there
    expect(selected()).toEqual(['Unstaged docs/manual.txt']);
    fireEvent.mouseDown(rows('Staged')[2]);
    fireEvent.mouseDown(rows('Staged')[2]); // then closed here
    expect(store.getState().diff).toBeNull();
    expect(selected()).toEqual(['Staged src/app.php']);
  });

  it('Enter/Space on a folder toggles it', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const box = screen.getByRole('listbox');
    const docs = () => screen.getAllByRole('option').find((r) => r.dataset.path === 'docs')!;
    fireEvent.mouseDown(docs()); // the cursor on the folder (collapsed)
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(docs()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(box, { key: ' ' });
    expect(docs()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a renamed file shows only its new name in the tree (H22)', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const renamed = screen.getAllByRole('option').find((r) => r.dataset.path === 'docs/manual.txt')!;
    expect(renamed.querySelector('.file-name')).toHaveTextContent(/^manual\.txt$/);
    expect(renamed.querySelector('.file-dir')).toBeNull();
    expect(renamed).not.toHaveTextContent('guide');
  });

  it('every row shows its full path on hover, a rename as old, ↓, new (H22)', () => {
    for (const mode of ['path', 'tree'] as const) {
      useFileListPrefs.getState().set({ mode, sort: 'path', allFiles: true });
      setup();
      const opt = (path: string) => screen.getAllByRole('option').find((r) => r.dataset.path === path)!;
      fireEvent.mouseEnter(opt('src/app.php'));
      expect(screen.getByRole('tooltip')).toHaveTextContent(/^src\/app\.php$/);
      fireEvent.mouseLeave(opt('src/app.php'));
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.mouseEnter(opt('docs/manual.txt'));
      const lines = within(screen.getByRole('tooltip')).getByTestId('rename-paths').children;
      expect([...lines].map((l) => l.textContent)).toEqual(['docs/guide.txt', '↓', 'docs/manual.txt']);
      fireEvent.mouseLeave(opt('docs/manual.txt'));
      cleanup();
    }
  });
});