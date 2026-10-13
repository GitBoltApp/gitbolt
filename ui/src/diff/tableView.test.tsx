import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { BlobSource } from '../api/gen/BlobSource';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { createRepoViewStore, fileViewTarget, RepoViewContext, targetFor, useRepoView, type DiffTarget } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { TABLE_DIFF_MAX_ROWS, TABLE_DIFF_TOO_LARGE } from '../table/rowDiff';
import { TABLE_MAX_CHARS, TABLE_TOO_LARGE } from '../table/limits';
import { DiffPanel } from './DiffPanel';
import { DEFAULT_DIFF_PREFS, DIFF_PREFS_STORAGE_KEY, useDiffPrefs } from './diffPrefs';
import { TABLE_MODE_TIP } from './DiffToolbar';
import { clearMarkdownOverride } from './markdownOverride';
import { useWorkingCopy } from './workingCopy';

const host = vi.hoisted(() => ({
  hexView: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
  attachDiff: vi.fn(), detachDiff: vi.fn(), showDiff: vi.fn(async () => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(),
  setModifiedEditable: vi.fn(), onModifiedEdit: vi.fn(), modifiedText: vi.fn(() => null), setFileEditable: vi.fn(), onFileEdit: vi.fn(),
  fileText: vi.fn(() => null), keepViewOnNextShow: vi.fn(), keepDiff: vi.fn(() => false), keepFile: vi.fn(() => false),
  setContextMenuHandler: vi.fn(), layout: vi.fn(), releaseDetached: vi.fn(), setLineGutter: vi.fn(), onDiffSelection: vi.fn(),
  fileScrollTop: vi.fn(() => 0), setFileScrollTop: vi.fn(), fileViewState: vi.fn(() => null), restoreFileViewState: vi.fn(),
}));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
vi.mock('../api/client', async (actual) => ({ ...(await actual<typeof import('../api/client')>()), api: { listOpeners: async () => [], openIn: async () => null } }));
vi.mock('../markdown/fileLinks', () => ({}));

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const P = 'a'.repeat(40);
const C = 'c'.repeat(40);
const spec = { kind: 'commit' as const, id: C, parent: 0 };
const blob = (text: string | null): BlobPayload => ({ size: text?.length ?? 8, binary: false, encoding: 'UTF-8', eol: 'lf', text, base64: null, hash: text === null ? null : 'h1' });
const contents = (old: BlobPayload | null, neu: BlobPayload | null): DiffContentsPayload => ({ old, new: neu, tooLarge: false, eolOnly: false, image: false });
const at = (commit: string): BlobSource => ({ kind: 'atCommit', commit });
const change = (path: string) => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 1, old: at(P), new: at(C), submodule: false });

function renderPanel(target: DiffTarget, load: () => Promise<DiffContentsPayload>) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents: new Loader(load, new Lru<string, DiffContentsPayload>(10)) }));
  act(() => store.getState().openFile(target));
  const Connected = () => {
    const diff = useRepoView((s) => s.diff);
    return diff && <DiffPanel target={diff} />;
  };
  render(<RepoViewContext value={store}><Connected /></RepoViewContext>);
  return { store };
}
const toggle = () => screen.queryByRole('group', { name: 'Table view' });
const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS });
  clearMarkdownOverride();
});

describe('a CSV or TSV file in File View', () => {
  it('shows as a table by default, the Source | Table toggle in the toolbar, the editor kept (hidden) under it', async () => {
    renderPanel(fileViewTarget('data/plants.csv', C, spec), async () => contents(null, blob('name,height\nfern,30\n')));
    const table = await screen.findByRole('table', { name: 'Table' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['name', 'height']);
    expect(within(toggle()!).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(host.showFile).toHaveBeenCalled());
    expect(screen.getByTestId('file-view')).not.toBeVisible();
  });

  it("Source shows the editor; the pick is the tables' own, app-wide and remembered", async () => {
    renderPanel(fileViewTarget('data/plants.tsv', C, spec), async () => contents(null, blob('name\theight\nfern\t30\n')));
    await screen.findByRole('table');
    fireEvent.click(within(toggle()!).getByRole('button', { name: 'Source' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByTestId('file-view')).toBeVisible();
    expect(JSON.parse(localStorage.getItem(DIFF_PREFS_STORAGE_KEY)!)).toMatchObject({ tableView: 'source', markdownView: 'rendered' });
  });

  it("Markdown's Source pick leaves tables as tables", async () => {
    act(() => useDiffPrefs.getState().set({ markdownView: 'source' }));
    renderPanel(fileViewTarget('data/plants.csv', C, spec), async () => contents(null, blob('name,height\nfern,30\n')));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('lines asked for (a link, a review badge) open Source at them', async () => {
    renderPanel({ ...fileViewTarget('data/plants.csv', C, spec), line: { side: 'modified', line: 2 } }, async () => contents(null, blob('name,height\nfern,30\n')));
    await waitFor(() => expect(host.showFile).toHaveBeenCalled());
    await waitFor(() => expect(within(toggle()!).getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByRole('table')).toBeNull();
    expect(useDiffPrefs.getState().prefs.tableView).toBe('rendered');
  });

  it('over 8 MB, shows the source with a note, and the toggle says why', async () => {
    renderPanel(fileViewTarget('data/huge.csv', C, spec), async () => contents(null, blob(`n\n${'1\n'.repeat(TABLE_MAX_CHARS / 2)}`)));
    expect(await screen.findByRole('note')).toHaveTextContent(TABLE_TOO_LARGE);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByTestId('file-view')).toBeVisible();
    await waitFor(() => expect(within(toggle()!).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-disabled', 'true'));
  });

  it('← scrolls the table back to its left edge, then goes back to the file list', async () => {
    const { store } = renderPanel(fileViewTarget('data/plants.csv', C, spec), async () => contents(null, blob('name,height\nfern,30\n')));
    const table = await screen.findByRole('table');
    act(() => store.getState().setFocus('diff'));
    table.scrollLeft = 40;
    // The table's own: the browser scrolls it.
    expect(fireEvent.keyDown(table, { key: 'ArrowLeft' })).toBe(true);
    expect(store.getState().focus).toBe('diff');
    table.scrollLeft = 0;
    expect(fireEvent.keyDown(table, { key: 'ArrowLeft' })).toBe(false);
    expect(store.getState().focus).toBe('files');
  });

  it('a text file has no Table toggle', async () => {
    renderPanel(fileViewTarget('notes.txt', C, spec), async () => contents(null, blob('a,b\n')));
    await waitFor(() => expect(host.showFile).toHaveBeenCalled());
    expect(toggle()).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('a CSV or TSV diff in Diff View', () => {
  it('shows the table diff, lined up by row, with the text-diff tools off saying why', async () => {
    renderPanel(targetFor(change('data/plants.csv'), spec), async () => contents(blob('name,height\nfern,30\nmoss,2\n'), blob('name,height\nfern,35\nmoss,2\n')));
    const table = await screen.findByRole('table', { name: 'Table diff' });
    const rows = within(table).getAllByRole('row').filter((r) => !r.classList.contains('csv-head'));
    expect(rows.map((r) => r.dataset.kind ?? 'same')).toEqual(['removed', 'added', 'same']);
    expect(screen.getByTestId('text-diff').closest('.file-source')).not.toBeVisible();
    await waitFor(() => { for (const name of ['Hunk', 'Inline', 'Split']) expect(button(name)).toHaveAttribute('aria-disabled', 'true'); });
    fireEvent.mouseEnter(button('Split'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(TABLE_MODE_TIP);
    fireEvent.mouseLeave(button('Split'));
    expect(button('Ignore whitespace')).toHaveAttribute('aria-disabled', 'true');
    expect(button('Next change')).toBeEnabled();
  });

  it('the toolbar goes by the text the body shows: an unsaved draft too large for a table makes both say Source', async () => {
    const target = targetFor(change('data/plants.csv'), spec);
    renderPanel(target, async () => contents(blob('n\n1\n'), blob('n\n2\n')));
    await screen.findByRole('table', { name: 'Table diff' });
    await waitFor(() => expect(button('Split')).toHaveAttribute('aria-disabled', 'true'));
    const big = `n\n${'1\n'.repeat(TABLE_DIFF_MAX_ROWS + 1)}`;
    act(() => useWorkingCopy.setState({ copies: { '': { key: target.key, path: target.path, worktree: '/r', repo: 1, base: null, dirty: true, draft: big } } }));
    expect(await screen.findByRole('note')).toHaveTextContent(TABLE_DIFF_TOO_LARGE);
    await waitFor(() => expect(within(toggle()!).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-disabled', 'true'));
    expect(button('Split')).not.toHaveAttribute('aria-disabled');
    act(() => useWorkingCopy.setState({ copies: {} }));
  });

  it(`over ${TABLE_DIFF_MAX_ROWS} rows a side, shows the source diff with a note, and the toggle says why`, async () => {
    const big = `n\n${'1\n'.repeat(TABLE_DIFF_MAX_ROWS + 1)}`;
    renderPanel(targetFor(change('data/big.csv'), spec), async () => contents(blob('n\n1\n'), blob(big)));
    expect(await screen.findByRole('note')).toHaveTextContent(TABLE_DIFF_TOO_LARGE);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByTestId('text-diff').closest('.file-source')).toBeVisible();
    const tableButton = within(toggle()!).getByRole('button', { name: 'Table' });
    expect(tableButton).toHaveAttribute('aria-disabled', 'true');
    expect(within(toggle()!).getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
    expect(button('Split')).not.toHaveAttribute('aria-disabled');
  });
});
