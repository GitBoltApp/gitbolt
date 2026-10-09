import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContext } from 'react';
import { useAppState } from '../app/state';
import { MdFontPx } from '../markdown/fontPx';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { setPendingScroll } from '../nav/scroll';
import { createRepoViewStore, fileViewTarget, RepoViewContext, useRepoView, worktreeViewTarget, type DiffTarget } from '../repo/store';
import { isMutableKey } from '../repo/services';
import { fakeServices } from '../repo/testServices';
import { useWorkingCopy } from './workingCopy';
import { DiffPanel } from './DiffPanel';
import { DEFAULT_DIFF_PREFS, DIFF_PREFS_STORAGE_KEY, useDiffPrefs } from './diffPrefs';
import { PARSE_BUDGET_MS, PRECHECK_BYTES, RENDER_MAX_BYTES, useSlowMarkdown } from './markdownFiles';

const host = vi.hoisted(() => ({
  hexView: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
  attachDiff: vi.fn(), detachDiff: vi.fn(), showDiff: vi.fn(async () => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), showFile: vi.fn(async (_req: { path: string }) => {}), setFileWordWrap: vi.fn(), focus: vi.fn(),
  setModifiedEditable: vi.fn(), onModifiedEdit: vi.fn(), modifiedText: vi.fn(() => null), setFileEditable: vi.fn(), onFileEdit: vi.fn(),
  fileText: vi.fn((_identity?: string): string | null => null), keepViewOnNextShow: vi.fn(), keepDiff: vi.fn(() => false), keepFile: vi.fn(() => false),
  setContextMenuHandler: vi.fn(), layout: vi.fn(), releaseDetached: vi.fn(),
  fileScrollTop: vi.fn(() => 0), setFileScrollTop: vi.fn(), fileViewState: vi.fn((): unknown => null), restoreFileViewState: vi.fn(),
}));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
const hexDump = vi.hoisted(() => vi.fn(async () => ({ old: null, new: { size: 4, shown: 4, dump: '00\n' }, cap: 262144 })));
vi.mock('../api/client', async (actual) => ({ ...(await actual<typeof import('../api/client')>()), api: { listOpeners: async () => [], openIn: async () => null, hexDump } }));
// 5A's renderer is tested by 5A: here, what File View hands it.
vi.mock('../markdown/fileLinks', () => ({}));
vi.mock('../markdown/lazy', () => ({
  Markdown: ({ text, context }: { text: string; context: { commit: string; path: string } }) => <div data-testid="md" data-commit={context.commit} data-path={context.path} data-font-px={useContext(MdFontPx)}>{text}</div>,
  MarkdownDiff: () => <div data-testid="md-diff" />,
}));

// 5A's chunk stream, timed by File View: each stream "takes" `parse.cost` ms of the mocked clock
// and finishes on a later tick (like the worker's reply).
// `cost: Infinity`: it never finishes; `tooLarge`: it fails as too large (the worker died).
const parse = vi.hoisted(() => ({ cost: 0, now: 0, calls: 0, tooLarge: false }));
vi.mock('../markdown/parseAsync', () => ({
  chunkStream: () => {
    parse.calls++;
    const fns = new Set<() => void>();
    const s = { chunks: [], done: false, failed: false, tooLarge: false, version: 0, subscribe: (f: () => void) => { fns.add(f); return () => { fns.delete(f); }; } };
    if (parse.tooLarge) return { ...s, done: true, failed: true, tooLarge: true };
    // A negative cost: a parse that never finishes.
    if (parse.cost >= 0) setTimeout(() => { parse.now += parse.cost; s.done = true; fns.forEach((f) => f()); }, 0);
    return s;
  },
}));

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const C = 'c'.repeat(40);
const spec = { kind: 'commit' as const, id: C, parent: 0 };
const blob = (text: string | null, binary = false): BlobPayload => ({ size: text?.length ?? 8, binary, encoding: binary ? '' : 'UTF-8', eol: 'lf', text, base64: null, hash: text === null ? null : 'h1' });
const contents = (next: BlobPayload | null, extra: Partial<DiffContentsPayload> = {}): DiffContentsPayload => ({ old: null, new: next, tooLarge: false, eolOnly: false, image: false, ...extra });

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
const toggle = () => screen.queryByRole('group', { name: 'Markdown view' });
const pick = (name: 'Source' | 'Rendered') => fireEvent.click(within(toggle()!).getByRole('button', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS });
});

describe('File View of a Markdown file (spec #5 §3.3)', () => {
  it('is Rendered by default, with the toggle in the diff toolbar, and the editor kept (hidden) under it', async () => {
    renderPanel(fileViewTarget('docs/guide.md', C, spec), async () => contents(blob('# Guide\n')));
    const md = await screen.findByTestId('md');
    expect(md).toHaveTextContent('# Guide');
    expect(md).toHaveAttribute('data-commit', C);
    expect(md).toHaveAttribute('data-path', 'docs/guide.md');
    expect(screen.getByRole('toolbar', { name: 'Diff options' })).toContainElement(toggle());
    expect(within(toggle()!).getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(host.showFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'docs/guide.md' })));
    expect(screen.getByTestId('file-view')).not.toBeVisible();
    expect(host.detachFile).not.toHaveBeenCalled();
  });

  it("sizes the rendered text like the editor (editorFontSize), and both views take the text-size zoom", async () => {
    const settings = useAppState.getState().settings;
    useAppState.setState({ settings: { ...settings, editorFontSize: 16 } });
    renderPanel(fileViewTarget('docs/guide.md', C, spec), async () => contents(blob('# Guide\n')));
    await screen.findByTestId('md');
    const pane = screen.getByTestId('markdown-file');
    expect(pane.style.getPropertyValue('--md-font-size')).toBe('16px');
    // Its chunks' placeholder heights are sized for it too (MdFontPx).
    expect(screen.getByTestId('md')).toHaveAttribute('data-font-px', '16');
    expect(pane).toHaveAttribute('data-font-zoom');
    expect(screen.getByTestId('file-view').closest('[data-font-zoom]')).not.toBeNull();
    act(() => useAppState.setState({ settings: { ...settings, editorFontSize: 40 } }));
    expect(pane.style.getPropertyValue('--md-font-size')).toBe('32px');
    act(() => useAppState.setState({ settings }));
  });

  it('Source shows the editor; the pick is app-wide and remembered', async () => {
    renderPanel(fileViewTarget('README.md', C, spec), async () => contents(blob('# Readme\n')));
    await screen.findByTestId('md');
    pick('Source');
    expect(screen.queryByTestId('md')).toBeNull();
    expect(screen.getByTestId('file-view')).toBeVisible();
    expect(within(toggle()!).getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(localStorage.getItem(DIFF_PREFS_STORAGE_KEY)!)).toMatchObject({ markdownView: 'source' });
  });

  it.each([
    ['a text file', fileViewTarget('a.txt', C, spec), contents(blob('a\n'))],
    ['a large file', fileViewTarget('big.md', C, spec), contents(blob(null), { tooLarge: true })],
    ['a binary file', fileViewTarget('odd.md', C, spec), contents(blob(null, true))],
  ])('shows no toggle for %s', async (_name, target, c) => {
    renderPanel(target, async () => c);
    await waitFor(() => expect(screen.getByTestId('diff-path')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 0));
    expect(toggle()).toBeNull();
    expect(screen.queryByTestId('md')).toBeNull();
  });

  it('the working copy: Rendered shows the unsaved buffer, keeps the editor attached, and Source comes back at the same cursor and scroll', async () => {
    useDiffPrefs.getState().set({ markdownView: 'source' });
    const target = worktreeViewTarget('notes.md', '/r', { kind: 'wip', worktree: '/r', staged: false });
    renderPanel(target, async () => contents(blob('# On disk\n')));
    await waitFor(() => expect(host.setFileEditable).toHaveBeenLastCalledWith(true));
    host.fileText.mockReturnValue('# Edited, not saved\n');
    const view = { cursorState: [], viewState: { scrollTop: 420 } };
    host.fileViewState.mockReturnValue(view);
    pick('Rendered');
    expect(await screen.findByTestId('md')).toHaveTextContent('# Edited, not saved');
    expect(screen.getByTestId('md')).toHaveAttribute('data-commit', 'worktree');
    expect(host.fileText).toHaveBeenCalledWith(target.key);
    expect(host.detachFile).not.toHaveBeenCalled();
    pick('Source');
    expect(host.restoreFileViewState).toHaveBeenCalledWith(view);
    expect(screen.getByTestId('file-view')).toBeVisible();
  });

  it('the working copy without unsaved edits: Rendered follows the file as it changes on disk', async () => {
    useDiffPrefs.getState().set({ markdownView: 'source' });
    const target = worktreeViewTarget('notes.md', '/r', { kind: 'wip', worktree: '/r', staged: false });
    let disk = '# On disk\n';
    const fetch = vi.fn(async (_k: string) => contents({ ...blob(disk), hash: `h-${disk.length}` }));
    // Working-tree contents are never cached (`isMutableKey`), as in `createServices`.
    const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents: new Loader(fetch, new Lru<string, DiffContentsPayload>(10), 4, (k) => !isMutableKey(k)) }));
    act(() => store.getState().openFile(target));
    render(<RepoViewContext value={store}><DiffPanel target={target} /></RepoViewContext>);
    await waitFor(() => expect(host.setFileEditable).toHaveBeenLastCalledWith(true));
    host.fileText.mockReturnValue('# On disk\n'); // the buffer is the file: nothing unsaved
    pick('Rendered');
    expect(await screen.findByTestId('md')).toHaveTextContent('# On disk');
    disk = '# Changed on disk\n';
    act(() => useWorkingCopy.setState({ epoch: { '': 1 } })); // a watcher refresh
    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('# Changed on disk'));
    act(() => useWorkingCopy.setState({ copies: {}, epoch: {} }));
  });

  it("a click in the rendered view doesn't put the keyboard in the hidden editor", async () => {
    renderPanel(fileViewTarget('README.md', C, spec), async () => contents(blob('# Readme\n')));
    fireEvent.click(await screen.findByTestId('md'));
    await new Promise((r) => setTimeout(r, 0));
    expect(host.focus).not.toHaveBeenCalled();
  });

  it('Back to a Rendered place scrolls the rendered view where it was (spec #5 §3.4)', async () => {
    setPendingScroll('', 'file', { key: `file:${C}:README.md`, view: 'rendered', top: 500, anchor: null });
    renderPanel(fileViewTarget('README.md', C, spec), async () => contents(blob('# Readme\n')));
    await screen.findByTestId('md');
    const pane = screen.getByTestId('markdown-file');
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 3000 });
    await waitFor(() => expect(pane.scrollTop).toBe(500));
  });
});

// --- 5B T7 ---
describe('too large to render (spec #5 §3.1)', () => {
  beforeEach(() => {
    Object.assign(parse, { cost: 0, now: 0, calls: 0, tooLarge: false });
    useSlowMarkdown.setState({ slow: {} });
    vi.spyOn(performance, 'now').mockImplementation(() => parse.now);
  });
  afterEach(() => vi.restoreAllMocks());

  it('over 5 MB: Source, with "Too large to render", and Rendered disabled', async () => {
    renderPanel(fileViewTarget('huge.md', C, spec), async () => contents(blob('x'.repeat(RENDER_MAX_BYTES + 1))));
    expect(await screen.findByRole('note')).toHaveTextContent('Too large to render');
    expect(screen.queryByTestId('md')).toBeNull();
    expect(screen.getByTestId('file-view')).toBeVisible();
    expect(within(toggle()!).getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(toggle()!).getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
    expect(parse.calls).toBe(0);
  });

  it('a long file whose parse takes over 2 s falls back to Source, and stays there this session', async () => {
    parse.cost = PARSE_BUDGET_MS + 500;
    const long = `# Long\n${'y'.repeat(PRECHECK_BYTES)}`;
    renderPanel(fileViewTarget('long.md', C, spec), async () => contents(blob(long)));
    expect(await screen.findByText('Rendering…')).toBeInTheDocument();
    expect(await screen.findByRole('note')).toHaveTextContent('Too large to render');
    expect(screen.queryByTestId('md')).toBeNull();
    expect(parse.calls).toBe(1);
    cleanup();
    renderPanel(fileViewTarget('long.md', C, spec), async () => contents(blob(long)));
    expect(await screen.findByRole('note')).toHaveTextContent('Too large to render');
    expect(screen.queryByText('Rendering…')).toBeNull();
    expect(parse.calls).toBe(1);
  });

  it('a parse still running at 2 s falls back to Source then, without waiting for its end', async () => {
    parse.cost = -1; // never finishes
    const long = `# Slow\n${'w'.repeat(PRECHECK_BYTES)}`;
    renderPanel(fileViewTarget('slow.md', C, spec), async () => contents(blob(long)));
    expect(await screen.findByText('Rendering…')).toBeInTheDocument();
    expect(await screen.findByRole('note', {}, { timeout: PARSE_BUDGET_MS + 1500 })).toHaveTextContent('Too large to render');
    expect(screen.queryByTestId('md')).toBeNull();
  }, PARSE_BUDGET_MS + 4000);

  it('a file too large for the main thread (the parse worker died) shows Source, "Too large to render"', async () => {
    parse.tooLarge = true;
    renderPanel(fileViewTarget('orphan.md', C, spec), async () => contents(blob(`# Orphan\n${'o'.repeat(PRECHECK_BYTES)}`)));
    expect(await screen.findByRole('note')).toHaveTextContent('Too large to render');
    expect(screen.queryByTestId('md')).toBeNull();
  });

  it('a long file that parses in time renders, after a "Rendering…" line', async () => {
    parse.cost = 50;
    renderPanel(fileViewTarget('fine.md', C, spec), async () => contents(blob(`# Fine\n${'z'.repeat(PRECHECK_BYTES)}`)));
    expect(await screen.findByText('Rendering…')).toBeInTheDocument();
    expect(await screen.findByTestId('md')).toHaveTextContent('# Fine');
    expect(screen.queryByRole('note')).toBeNull();
    expect(parse.calls).toBe(1);
  });
});
// --- end 5B T7 ---
