import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };

function setup(services: RepoServices = fakeServices({ treeFiles: new Loader(async () => ['docs/manual.txt', 'logo.png', 'src/app.php', 'zzz.txt'], new Lru(2)) })) {
  const store = createRepoViewStore(1, '/r', graph, services);
  render(<RepoViewContext value={store}><FileList list={list} spec={spec} label="Changed files" allFilesCommit={spec.id} /></RepoViewContext>);
  return store;
}

/** The rows and the list, whatever their roles: tree mode is a `tree` of `treeitem`s (M8), path mode a `listbox` of `option`s. */
const rowEls = () => [...document.querySelectorAll<HTMLElement>('[role="option"], [role="treeitem"]')];
const listEl = () => document.querySelector<HTMLElement>('.file-list-scroll')!;

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
    const rows = rowEls();
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
    const docs = rowEls().find((r) => r.dataset.path === 'docs')!;
    expect(docs).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseDown(docs);
    expect(rowEls().find((r) => r.dataset.path === 'docs')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(listEl(), { key: 'ArrowRight' });
    expect(rowEls().find((r) => r.dataset.path === 'docs')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(rowEls().every((r) => r.dataset.kind === 'folder' || r.dataset.path === 'logo.png')).toBe(true);
  });

  it('View all files lists unchanged files from the commit tree', async () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: true });
    setup();
    expect(await screen.findByText('zzz.txt')).toBeInTheDocument();
    expect(rowEls()).toHaveLength(4);
  });

  it('opening a file prefetches the contents of the files on either side', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const rec = recordingServices();
    setup(rec.services);
    fireEvent.mouseDown(rowEls()[1]);
    const key = (path: string) => `contents ${contentKey(contentsRequest(targetFor(list.files.find((f) => f.path === path)!, spec)))}`;
    expect(rec.calls).toEqual([key('docs/manual.txt'), key('src/app.php')]);
  });

  it("rows are the density preset's height, following a change (H1)", () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    setup();
    for (const d of DENSITIES) {
      act(() => useDensity.setState({ density: d }));
      const h = DENSITY_METRICS[d].fileRowH;
      expect(rowEls()[2], d).toHaveStyle({ height: `${h}px`, top: `${2 * h}px` });
    }
    // The default, standard, is taller than 1B's fixed 24 px; compact keeps it.
    expect(DENSITY_METRICS[DEFAULT_DENSITY].fileRowH).toBe(26);
    expect(DENSITY_METRICS.compact.fileRowH).toBe(24);
  });

  it('J2: → opens the active file (nothing if it is open); ← closes the diff and returns to the graph', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    const rows = () => rowEls();
    const box = listEl();
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
    const box = listEl();
    const opt = (path: string) => rowEls().find((r) => r.dataset.path === path)!;
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
    const box = listEl();
    const opt = (path: string) => rowEls().find((r) => r.dataset.path === path)!;
    const key = (k: string) => fireEvent.keyDown(box, { key: k });
    const open = () => store.getState().diff?.path;
    // Rows: docs/, manual.txt, src/, app.php, logo.png.
    expect(rowEls().map((r) => r.dataset.kind)).toEqual(['folder', 'file', 'folder', 'file', 'file']);
    key('ArrowDown'); // nothing active yet: the first file
    expect(open()).toBe('docs/manual.txt');
    key('ArrowDown');
    expect(open()).toBe('src/app.php');
    expect(opt('src/app.php')).toHaveAttribute('aria-selected', 'true');
    key('ArrowDown');
    expect(open()).toBe('logo.png');
    key('ArrowDown'); // K4: the last file wraps to the first
    expect(open()).toBe('docs/manual.txt');
    key('ArrowUp'); // K4: the first file wraps to the last
    expect(open()).toBe('logo.png');
    key('ArrowUp');
    expect(open()).toBe('src/app.php');
    key('ArrowUp');
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
    // src/ is collapsed now: Down walks into it (UX round 2), expanding it, onto its first file.
    expect(opt('src')).toHaveAttribute('aria-expanded', 'false');
    key('ArrowDown');
    expect(open()).toBe('src/app.php');
    expect(opt('src')).toHaveAttribute('aria-expanded', 'true');
    expect(opt('src/app.php')).toHaveAttribute('aria-selected', 'true');
  });

  it('UX round 2: Up/Down walk into nested collapsed directories, expanding them, in both directions', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const files = ['lib/one/p.txt', 'lib/one/q.txt', 'lib/two/r.txt', 'lib/two/s.txt', 'a.txt', 'z.txt'].map((p) => change(p));
    render(<RepoViewContext value={store}><FileList list={{ files, added: 0, deleted: 0 }} spec={spec} label="Changed files" /></RepoViewContext>);
    const opt = (path: string) => rowEls().find((r) => r.dataset.path === path)!;
    const key = (k: string) => fireEvent.keyDown(listEl(), { key: k });
    const open = () => store.getState().diff?.path;
    const shown = () => rowEls().map((r) => r.dataset.path);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(shown()).toEqual(['lib', 'a.txt', 'z.txt']);
    // ↑ from a.txt: lib/ and its last child two/ expand; on to two/'s last file. one/ stays shut.
    fireEvent.mouseDown(opt('a.txt'));
    key('ArrowUp');
    expect(open()).toBe('lib/two/s.txt');
    expect(shown()).toEqual(['lib', 'lib/one', 'lib/two', 'lib/two/r.txt', 'lib/two/s.txt', 'a.txt', 'z.txt']);
    expect(opt('lib/two/s.txt')).toHaveAttribute('aria-selected', 'true');
    key('ArrowUp');
    expect(open()).toBe('lib/two/r.txt');
    key('ArrowUp'); // one/ is the previous row, collapsed: its last file
    expect(open()).toBe('lib/one/q.txt');
    expect(opt('lib/one')).toHaveAttribute('aria-expanded', 'true');
    // ↓, past the end (wrapping), into lib/ and its first child one/, both collapsed again.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    fireEvent.mouseDown(opt('z.txt'));
    key('ArrowDown');
    expect(open()).toBe('lib/one/p.txt');
    expect(shown()).toEqual(['lib', 'lib/one', 'lib/one/p.txt', 'lib/one/q.txt', 'lib/two', 'a.txt', 'z.txt']);
    key('ArrowDown');
    expect(open()).toBe('lib/one/q.txt');
    key('ArrowDown'); // two/ is the next row, collapsed: its first file
    expect(open()).toBe('lib/two/r.txt');
    expect(opt('lib/two')).toHaveAttribute('aria-expanded', 'true');
    // The expansion stays, as a click on the chevron would leave it.
    key('ArrowDown');
    key('ArrowDown');
    expect(open()).toBe('a.txt');
    expect(shown()).toHaveLength(9);
  });

  it('J3: PgUp/PgDn step a page of rows and land on a file, never a folder', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    // Folders a/ … f/ with one file each: rows alternate folder, file.
    const many = { files: 'abcdef'.split('').map((d) => change(`${d}/x.txt`)), added: 6, deleted: 0 };
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    render(<RepoViewContext value={store}><FileList list={many} spec={spec} label="Changed files" /></RepoViewContext>);
    const box = listEl();
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
    fireEvent.mouseDown(rowEls()[2]);
    expect(store.getState().diff?.path).toBe('src/app.php');
    act(() => store.getState().closeDiff());
    // Enter in the graph: openFirstFile opens the first file.
    act(() => store.getState().openFile(targetFor(list.files[0], spec)));
    const rows = rowEls();
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    fireEvent.keyDown(listEl(), { key: 'ArrowDown' });
    expect(store.getState().diff?.path).toBe('logo.png');
  });

  it('tree ←/→ on the open file\'s folder with a diff open collapse and expand it, keeping the cursor there', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    const store = setup();
    const box = listEl();
    const opt = (path: string) => rowEls().find((r) => r.dataset.path === path);
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
    const box = listEl();
    expect(box).not.toHaveAttribute('aria-activedescendant');
    fireEvent.mouseDown(rowEls()[1]);
    const active = rowEls()[1];
    expect(active.id).not.toBe('');
    expect(box).toHaveAttribute('aria-activedescendant', active.id);
    expect(new Set(rowEls().map((o) => o.id)).size).toBe(3);
  });

  describe('View all files loading (K54)', () => {
    const gates = new Map<string, (paths: string[]) => void>();
    const deferred = () => fakeServices({ treeFiles: new Loader((c: string) => new Promise<string[]>((r) => { gates.set(c, r); }), new Lru(4)) });
    const filter = () => screen.queryByRole('textbox', { name: 'Filter files' });

    it('keeps the previous list, without the filter bar, under a late progress line until the tree is here, then swaps once', async () => {
      vi.useFakeTimers();
      try {
        useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
        setup(deferred());
        const before = rowEls().map((o) => o.dataset.path);
        act(() => { fireEvent.click(screen.getByRole('button', { name: 'View all files' })); });
        // Asked for, but not switched: same rows, no filter bar, and no progress line yet.
        expect(screen.getByRole('button', { name: 'View all files' })).toHaveAttribute('aria-pressed', 'true');
        expect(filter()).toBeNull();
        expect(screen.queryByRole('progressbar')).toBeNull();
        act(() => { vi.advanceTimersByTime(149); });
        expect(screen.queryByRole('progressbar')).toBeNull();
        act(() => { vi.advanceTimersByTime(1); });
        expect(screen.getByRole('progressbar', { name: 'Loading all files' })).toBeInTheDocument();
        expect(rowEls().map((o) => o.dataset.path)).toEqual(before);
        expect(filter()).toBeNull();
        // The data arrives: the layout and rows switch together.
        await act(async () => { gates.get(spec.id)!(['docs/manual.txt', 'logo.png', 'src/app.php', 'zzz.txt']); });
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(filter()).not.toBeNull();
        expect(rowEls()).toHaveLength(4);
        // Turning it off is immediate.
        act(() => { fireEvent.click(screen.getByRole('button', { name: 'View all files' })); });
        expect(filter()).toBeNull();
        expect(rowEls()).toHaveLength(3);
      } finally { vi.useRealTimers(); }
    });

    it('a load for a commit that was moved off is dropped', async () => {
      useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: true });
      const store = createRepoViewStore(1, '/r', graph, deferred());
      const el = (commit: string) => <RepoViewContext value={store}><FileList list={list} spec={{ ...spec, id: commit }} label="Changed files" allFilesCommit={commit} /></RepoViewContext>;
      const { rerender } = render(el('a'.repeat(40)));
      rerender(el('b'.repeat(40)));
      await act(async () => { gates.get('b'.repeat(40))!(['docs/manual.txt', 'logo.png', 'src/app.php', 'from-b.txt']); });
      await act(async () => { gates.get('a'.repeat(40))!(['docs/manual.txt', 'logo.png', 'src/app.php', 'from-a.txt']); });
      expect(screen.getByText('from-b.txt')).toBeInTheDocument();
      expect(screen.queryByText('from-a.txt')).toBeNull();
    });
  });

  it('a failed View all files load shows an error row with a retry', async () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: true });
    let fail = true;
    setup(fakeServices({ treeFiles: new Loader(async () => { if (fail) throw new Error('tree walk failed'); return ['zzz.txt']; }, new Lru(2)) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('tree walk failed');
    expect(rowEls()).toHaveLength(3); // the changed files are still listed
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('zzz.txt')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tree mode: no folder icons, and each file\'s icon starts where its folder\'s name does (F17)', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const opt = (path: string) => rowEls().find((r) => r.dataset.path === path)!;
    expect(opt('docs').querySelector('.lucide-folder')).toBeNull();
    expect(opt('docs').querySelectorAll('svg')).toHaveLength(1); // the chevron only
    expect(opt('docs')).toHaveStyle({ paddingLeft: `${rowIndent(0)}px` });
    expect(opt('docs/manual.txt')).toHaveStyle({ paddingLeft: `${rowIndent(1)}px` });
    expect(opt('logo.png')).toHaveStyle({ paddingLeft: `${rowIndent(0)}px` });
  });

  it('a collapsed folder shows its change counts; an expanded one doesn\'t (F20)', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const opt = (path: string) => rowEls().find((r) => r.dataset.path === path)!;
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
    expect(rowEls().filter((r) => r.dataset.kind === 'folder').every((r) => r.getAttribute('aria-expanded') === 'false')).toBe(true);
    const expand = within(toolbar).getByRole('button', { name: 'Expand all' });
    expect(within(toolbar).queryByRole('button', { name: 'Collapse all' })).toBeNull();
    fireEvent.click(expand);
    expect(rowEls().filter((r) => r.dataset.kind === 'folder').every((r) => r.getAttribute('aria-expanded') === 'true')).toBe(true);
    // Only some collapsed: it expands all.
    fireEvent.mouseDown(rowEls().find((r) => r.dataset.path === 'docs')!);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Expand all' }));
    expect(rowEls().find((r) => r.dataset.path === 'docs')).toHaveAttribute('aria-expanded', 'true');
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
    expect(within(rowEls()[0]).getByTestId('folder-counts')).toHaveAccessibleName('1 modified · 1 conflicted');
    expect(within(rowEls()[0]).queryByRole('img', { name: 'Unmerged' })).toBeNull(); // folder icons are decorative
  });

  it('clicking the open file closes it, and Enter/Space toggle the active file (H5b)', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    const box = listEl();
    const row = () => rowEls()[2];
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

  // K2, K3: the browser counts quick presses as one multi-click (`detail` 2, 3, …, within the
  // OS double-click time). Every one of them is a toggle: none is dropped as a "double-click".
  it('every press toggles, however quick: a file opens and closes, a folder collapses and expands (K2, K3)', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    const row = () => rowEls()[2];
    fireEvent.mouseDown(row(), { detail: 1 });
    expect(store.getState().diff?.path).toBe('src/app.php');
    fireEvent.mouseDown(row(), { detail: 2 });
    expect(store.getState().diff).toBeNull();
    fireEvent.mouseDown(row(), { detail: 3 });
    expect(store.getState().diff?.path).toBe('src/app.php');
    cleanup();
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const docs = () => rowEls().find((r) => r.dataset.path === 'docs')!;
    expect(docs()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseDown(docs(), { detail: 1 });
    expect(docs()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.mouseDown(docs(), { detail: 2 });
    expect(docs()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseDown(docs(), { detail: 3 });
    expect(docs()).toHaveAttribute('aria-expanded', 'false');
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
    const selected = () => rowEls().filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => `${o.closest('[role="listbox"]')!.getAttribute('aria-label')} ${o.dataset.path}`);
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
    const box = listEl();
    const docs = () => rowEls().find((r) => r.dataset.path === 'docs')!;
    fireEvent.mouseDown(docs()); // the cursor on the folder (collapsed)
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(docs()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(box, { key: ' ' });
    expect(docs()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a renamed file shows only its new name in the tree (H22)', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    const renamed = rowEls().find((r) => r.dataset.path === 'docs/manual.txt')!;
    expect(renamed.querySelector('.file-name')).toHaveTextContent(/^manual\.txt$/);
    expect(renamed.querySelector('.file-dir')).toBeNull();
    expect(renamed).not.toHaveTextContent('guide');
  });

  it('every row shows its full path on hover, a rename as old, ↓, new (H22)', () => {
    for (const mode of ['path', 'tree'] as const) {
      useFileListPrefs.getState().set({ mode, sort: 'path', allFiles: true });
      setup();
      const opt = (path: string) => rowEls().find((r) => r.dataset.path === path)!;
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

  it('K4: ↓ wraps from the last file to the first, and ↑ from the first to the last, in path mode too', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    const box = listEl();
    const key = (k: string) => fireEvent.keyDown(box, { key: k });
    const open = () => store.getState().diff?.path;
    key('End');
    expect(open()).toBe('src/app.php'); // the last file, path order
    key('ArrowDown');
    expect(open()).toBe('docs/manual.txt'); // wraps to the first
    key('ArrowUp');
    expect(open()).toBe('src/app.php'); // wraps back to the last
  });

  describe('K18-K20: the "View all files" filter', () => {
    function setupAllFiles() {
      useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: true });
      return setup();
    }

    it('is only shown in View all files mode', async () => {
      useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
      setup();
      expect(screen.queryByLabelText('Filter files')).toBeNull();
      cleanup();
      setupAllFiles();
      expect(await screen.findByLabelText('Filter files')).toBeInTheDocument();
    });

    it('narrows the list by a case-insensitive path substring and highlights the match', async () => {
      setupAllFiles();
      await screen.findByText('zzz.txt'); // docs/manual.txt, logo.png, src/app.php, zzz.txt
      expect(rowEls()).toHaveLength(4);
      fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'APP' } });
      const rows = rowEls();
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.path).toBe('src/app.php');
      expect(rows[0].querySelector('mark.filter-match')).toHaveTextContent('app');
    });

    it('keeps the selection while the selected file still matches, and drops it once it stops matching', async () => {
      setupAllFiles();
      await screen.findByText('zzz.txt');
      fireEvent.mouseDown(rowEls().find((r) => r.dataset.path === 'src/app.php')!);
      const filter = screen.getByLabelText('Filter files');
      fireEvent.change(filter, { target: { value: 'app' } });
      expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
      fireEvent.change(filter, { target: { value: 'zzz' } });
      expect(screen.queryByRole('option', { selected: true })).toBeNull();
    });

    it('Esc clears the filter first; with the filter already empty, Esc goes to the app\'s Esc (closes the file)', async () => {
      const store = setupAllFiles();
      await screen.findByText('zzz.txt');
      fireEvent.mouseDown(rowEls().find((r) => r.dataset.path === 'src/app.php')!);
      expect(store.getState().diff?.path).toBe('src/app.php');
      const filter = screen.getByLabelText('Filter files');
      fireEvent.change(filter, { target: { value: 'app' } });
      fireEvent.keyDown(filter, { key: 'Escape' });
      expect(filter).toHaveValue('');
      expect(store.getState().diff?.path).toBe('src/app.php'); // the first Esc only cleared the filter
      fireEvent.keyDown(filter, { key: 'Escape' });
      expect(store.getState().diff).toBeNull(); // the second, with nothing to clear, is the app's Esc
    });

    it('X clears the filter and re-centres the selected row; the clear and step buttons disable appropriately', async () => {
      setupAllFiles();
      await screen.findByText('zzz.txt');
      const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');
      const clear = screen.getByRole('button', { name: 'Clear filter' });
      expect(clear).toBeDisabled();
      fireEvent.mouseDown(rowEls().find((r) => r.dataset.path === 'src/app.php')!);
      const filter = screen.getByLabelText('Filter files');
      fireEvent.change(filter, { target: { value: 'app' } });
      expect(clear).not.toBeDisabled();
      scrollTo.mockClear();
      fireEvent.click(clear);
      expect(filter).toHaveValue('');
      expect(rowEls()).toHaveLength(4);
      expect(scrollTo).toHaveBeenCalled(); // K20: centres the still-selected row
    });

    it('K19: Previous/Next changed file jump to and open the nearest changed file, skipping unchanged rows, and wrap', async () => {
      const store = setupAllFiles();
      await screen.findByText('zzz.txt'); // docs/manual.txt, logo.png, src/app.php (changed), zzz.txt (unchanged)
      const prev = screen.getByRole('button', { name: 'Previous changed file' });
      const next = screen.getByRole('button', { name: 'Next changed file' });
      expect(prev).not.toBeDisabled();
      fireEvent.click(next);
      expect(store.getState().diff?.path).toBe('docs/manual.txt');
      fireEvent.click(next);
      expect(store.getState().diff?.path).toBe('logo.png');
      fireEvent.click(next);
      expect(store.getState().diff?.path).toBe('src/app.php');
      fireEvent.click(next); // wraps, skipping zzz.txt (unchanged)
      expect(store.getState().diff?.path).toBe('docs/manual.txt');
      fireEvent.click(prev); // wraps the other way, skipping zzz.txt
      expect(store.getState().diff?.path).toBe('src/app.php');
    });

    it('K19: Previous/Next are disabled with no changed file visible', async () => {
      setupAllFiles();
      await screen.findByText('zzz.txt');
      fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'zzz' } });
      expect(screen.getByRole('button', { name: 'Previous changed file' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Next changed file' })).toBeDisabled();
    });

    it('turning View all files off clears the filter (it is never persisted)', async () => {
      setupAllFiles();
      await screen.findByText('zzz.txt');
      fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'app' } });
      fireEvent.click(screen.getByRole('button', { name: 'View all files' }));
      expect(screen.queryByLabelText('Filter files')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'View all files' }));
      expect(screen.getByLabelText('Filter files')).toHaveValue('');
    });
  });
});