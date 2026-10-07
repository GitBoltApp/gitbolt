import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { useAppEscape } from '../repo/escape';
import { contentKey, isMutableKey } from '../repo/services';
import { contentsRequest, createRepoViewStore, fileViewTarget, RepoViewContext, targetFor, useRepoView, type DiffTarget } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { DiffHeader, DiffPanel } from './DiffPanel';
import { DEFAULT_DIFF_PREFS, DIFF_PREFS_STORAGE_KEY, useDiffPrefs } from './diffPrefs';
import { BINARY_MODE_TIP, DiffToolbar } from './DiffToolbar';
import { useWorkingCopy } from './workingCopy';
import '../app/coreActions';
import { installShortcuts } from '../app/shortcuts';
import { activeTabWith } from '../app/testShell';

const host = vi.hoisted(() => {
  // A binary's hex view (hex.tsx's HexView): what it was asked to show.
  const hexShow = vi.fn((_req: { path: string; file: boolean; old: unknown; new: unknown }) => {});
  return {
  hexShow, hexView: vi.fn((_el: HTMLElement) => ({ show: hexShow, dispose: vi.fn() })),
  attachDiff: vi.fn(), detachDiff: vi.fn(), showDiff: vi.fn(async (_req: { path: string }) => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(), setModifiedEditable: vi.fn(), onModifiedEdit: vi.fn(), modifiedText: vi.fn(() => null), setFileEditable: vi.fn(), onFileEdit: vi.fn(), fileText: vi.fn(() => null), keepViewOnNextShow: vi.fn(), fileScrollTop: vi.fn(() => null), setFileScrollTop: vi.fn(), keepDiff: vi.fn((_el: HTMLElement, _next: unknown) => false), keepFile: vi.fn((_el: HTMLElement, _next: unknown) => false),
  setContextMenuHandler: vi.fn(), layout: vi.fn(),
  };
});
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
// The header's "Open in…" loads the openers: none here, and no socket to a harness
// (DiffPanel.openIn.test.tsx covers the button).
// A binary's hex dumps (hex.tsx): each side's kind and path, so a test can tell which side shows.
const hexSide = (src: { kind: string }, path: string) => (src.kind === 'absent' ? null : { size: 9, shown: 9, dump: `${src.kind} ${path}\n` });
const hexDump = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (actual) => ({ ...(await actual<typeof import('../api/client')>()), api: { listOpeners: async () => [], openIn: async () => null, hexDump } }));

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const spec = { kind: 'commit' as const, id: 'c'.repeat(40), parent: 0 };
const blob = (text: string | null, encoding = 'UTF-8', binary = false): BlobPayload => ({ size: text?.length ?? 8, binary, encoding, eol: 'lf', text, base64: null, hash: null });
const sized = (p: Partial<BlobPayload>): BlobPayload => ({ size: 10, binary: false, encoding: 'UTF-8', eol: 'lf', text: 'x\n', base64: null, hash: null, ...p });
const contents = (old: BlobPayload | null, next: BlobPayload | null, extra: Partial<DiffContentsPayload> = {}): DiffContentsPayload => ({ old, new: next, tooLarge: false, eolOnly: false, image: false, ...extra });
const change = (path: string, status = 'M'): FileChange => ({ path, oldPath: null, status, additions: 1, deletions: 1, old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, submodule: false });
const text = async () => contents(blob('a\n'), blob('b\n'));

function renderPanel(target: DiffTarget, load: (key: string) => Promise<DiffContentsPayload>) {
  const fetch = vi.fn(load);
  const loader = new Loader(fetch, new Lru<string, DiffContentsPayload>(10));
  const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents: loader }));
  act(() => store.getState().openFile(target));
  // Re-render with the store's target, so File/Diff View switches reach the panel as in RepoView.
  const Connected = () => {
    const diff = useRepoView((s) => s.diff);
    useAppEscape(store); // RepoView's app-wide Esc (J4), which closes the file
    return diff && <DiffPanel target={diff} />;
  };
  const view = render(<RepoViewContext value={store}><Connected /></RepoViewContext>);
  return { store, loader, fetch, view };
}
const button = (name: string | RegExp) => screen.getByRole('button', { name });

import { BUSY_DELAY_MS as BUSY_DELAY } from '../util/lateFlag';
describe('DiffPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS });
    hexDump.mockImplementation(async (_repo: number, r: { path: string; old: { kind: string }; new: { kind: string } }) => ({ old: hexSide(r.old, 'old'), new: hexSide(r.new, 'new'), cap: 262144 }));
  });
  afterEach(() => vi.clearAllMocks());

  it('shows the path breadcrumb, the encoding and the text diff, and × closes it', async () => {
    const target = targetFor(change('src/app.php'), spec);
    const { store } = renderPanel(target, async () => contents(blob('<?php 1\n'), blob('<?php 2\n')));
    const region = screen.getByRole('region', { name: 'Diff' });
    expect(screen.getByTestId('diff-path')).toHaveTextContent('src/app.php');
    expect(screen.getByTestId('diff-path').querySelector('strong')).toHaveTextContent(/^app\.php$/);
    expect(await screen.findByTestId('diff-encoding')).toHaveTextContent('UTF-8');
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/app.php', original: '<?php 1\n', modified: '<?php 2\n', language: 'php' })));
    expect(region).toContainElement(screen.getByTestId('text-diff'));
    fireEvent.click(button('Close diff'));
    expect(store.getState().diff).toBeNull();
    expect(store.getState().focus).toBe('graph');
  });

  it("a target's line (a note's file:line) goes to the editor's show, again on each open, even of the same file", async () => {
    const line = { side: 'modified', line: 92 } as const;
    const { store } = renderPanel({ ...targetFor(change('src/app.php'), spec), line }, text);
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/app.php', line })));
    const shows = host.showDiff.mock.calls.length;
    act(() => store.getState().openFile({ ...targetFor(change('src/app.php'), spec), line: { side: 'original', line: 7 } }));
    await waitFor(() => expect(host.showDiff).toHaveBeenLastCalledWith(expect.objectContaining({ line: { side: 'original', line: 7 } })));
    expect(host.showDiff).toHaveBeenCalledTimes(shows + 1);
  });

  it.each([
    ['A', 'Added'],
    ['M', 'Modified'],
    ['D', 'Deleted'],
    ['R', 'Renamed'],
    ['U', 'Unmerged'],
    ['X', 'Unknown'],
  ])('shows the %s change-kind icon at the top left, labelled %s (F21)', async (status, label) => {
    const target = targetFor(change('src/app.php', status), spec);
    renderPanel(target, text);
    const path = await screen.findByTestId('diff-path');
    const icon = path.previousElementSibling;
    expect(icon).toHaveAttribute('aria-label', label);
  });

  it('an unchanged file in File View shows a spacer, not an icon, so the path lines up (F21)', async () => {
    renderPanel(fileViewTarget('a.txt', spec.id, spec), async () => contents(null, blob('a\n')));
    const path = await screen.findByTestId('diff-path');
    const spacer = path.previousElementSibling;
    expect(spacer).toHaveClass('status-spacer');
    expect(spacer).toHaveAttribute('aria-hidden', 'true');
  });

  it('moving between prefetched files keeps the editor attached (no loading frame in between)', async () => {
    const a = targetFor(change('a.txt'), spec);
    const b = targetFor(change('b.txt'), spec);
    const loader = new Loader(async (k: string) => (k.includes('a.txt') ? contents(blob('a1\n'), blob('a2\n')) : contents(blob('b1\n'), blob('b2\n'))), new Lru<string, DiffContentsPayload>(10));
    await Promise.all([a, b].map((t) => loader.get(contentKey(contentsRequest(t)))));
    const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents: loader }));
    const view = render(<RepoViewContext value={store}><DiffPanel target={a} /></RepoViewContext>);
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.txt' })));
    const editor = screen.getByTestId('text-diff');
    view.rerender(<RepoViewContext value={store}><DiffPanel target={b} /></RepoViewContext>);
    await waitFor(() => expect(host.showDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'b.txt', original: 'b1\n', modified: 'b2\n' })));
    // A "Loading…" frame would have unmounted TextDiff, detaching and re-attaching the editor.
    expect(screen.getByTestId('text-diff')).toBe(editor);
    expect(host.detachDiff).not.toHaveBeenCalled();
    expect(host.attachDiff).toHaveBeenCalledTimes(1);
  });

  it('a file still loading keeps the previous one on screen, header included, and shows Loading only after a moment', async () => {
    const a = targetFor(change('a.txt'), spec);
    const b = targetFor(change('b.txt'), spec);
    const { store } = renderPanel(a, (k) => (k.includes('b.txt') ? new Promise<DiffContentsPayload>(() => {}) : Promise.resolve(contents(blob('a1\n'), blob('a2\n')))));
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.txt' })));
    const editor = screen.getByTestId('text-diff');
    act(() => store.getState().openFile(b));
    // The whole panel switches when b is ready, in one render: no "Loading…" frame in between.
    expect(screen.getByTestId('diff-path')).toHaveTextContent('a.txt');
    expect(screen.getByTestId('text-diff')).toBe(editor);
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(button('Next change')).toBeEnabled();
    // A slow load says so, rather than leaving a stale file under the new selection.
    expect(await screen.findByText('Loading…', undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByTestId('diff-path')).toHaveTextContent('b.txt');
    expect(host.showDiff).toHaveBeenCalledTimes(1);
  });

  it('header and toolbar switch together with the editor: the previous path stays until the new diff is on screen', async () => {
    const a = targetFor(change('a.txt'), spec);
    const b = targetFor(change('b.bin'), spec);
    let release!: () => void;
    host.showDiff.mockImplementation(async (req: { path: string }) => {
      if (req.path === 'b.bin') await new Promise<void>((r) => { release = r; });
    });
    const { store } = renderPanel(a, async (k) => (k.includes('b.bin') ? contents(blob('b1\n', 'ISO-8859-1'), blob('b2\n', 'ISO-8859-1')) : contents(blob('a1\n'), blob('a2\n'))));
    await waitFor(() => expect(screen.getByTestId('diff-encoding')).toHaveTextContent('UTF-8'));
    act(() => store.getState().openFile(b));
    await waitFor(() => expect(host.showDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'b.bin' })));
    expect(screen.getByTestId('diff-path')).toHaveTextContent('a.txt');
    expect(screen.getByTestId('diff-encoding')).toHaveTextContent('UTF-8');
    await act(async () => release());
    expect(screen.getByTestId('diff-path')).toHaveTextContent('b.bin');
    expect(screen.getByTestId('diff-encoding')).toHaveTextContent('ISO-8859-1');
    host.showDiff.mockImplementation(async () => {});
  });

  // K7 (lane V's report): the header waits for the editor only while the editor is what still
  // shows the header's file. From a message (a large file, a binary, an image, a failed load) or
  // across Diff/File View, the body has already moved on: the header goes with it at once,
  // instead of naming the previous file over the next one's (hidden, still loading) editor.
  it('switching from a file the editor does not show, the header follows the body at once (K7)', async () => {
    const big = targetFor(change('big.txt'), spec);
    const b = targetFor(change('b.txt'), spec);
    const c = targetFor(change('c.txt'), spec);
    const released: (() => void)[] = [];
    host.showDiff.mockImplementation(() => new Promise<void>((r) => { released.push(r); }));
    host.showFile.mockImplementation(() => new Promise<void>((r) => { released.push(r); }));
    const { store } = renderPanel(big, async (k) => (k.includes('big.txt') ? contents(sized({ size: 3_000_000, text: null }), sized({ size: 3_000_001, text: null }), { tooLarge: true }) : contents(blob('1\n'), blob(`${k}\n`))));
    expect(await screen.findByText('Large file — load anyway?')).toBeInTheDocument();
    act(() => store.getState().openFile(b));
    await waitFor(() => expect(host.showDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'b.txt' })));
    expect(screen.getByTestId('diff-path')).toHaveTextContent('b.txt');
    await act(async () => released.forEach((r) => r()));
    // Diff View of b to File View of c: a different editor, so nothing of b stays on screen.
    act(() => store.getState().openFile({ ...c, view: 'file' }));
    await waitFor(() => expect(host.showFile).toHaveBeenCalled());
    expect(screen.getByTestId('diff-path')).toHaveTextContent('c.txt');
    await act(async () => released.forEach((r) => r()));
    host.showDiff.mockImplementation(async () => {});
    host.showFile.mockImplementation(async () => {});
  });

  it("the next file's line-endings banner waits with the header, over the previous file's diff (K7)", async () => {
    const a = targetFor(change('a.txt'), spec);
    const crlf = targetFor(change('crlf.txt'), spec);
    let release!: () => void;
    host.showDiff.mockImplementation(async (req: { path: string }) => {
      if (req.path === 'crlf.txt') await new Promise<void>((r) => { release = r; });
    });
    const { store } = renderPanel(a, async (k) => (k.includes('crlf') ? contents({ ...blob('x\r\n'), eol: 'crlf' }, blob('x\n'), { eolOnly: true }) : text()));
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledTimes(1));
    act(() => store.getState().openFile(crlf));
    await waitFor(() => expect(host.showDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'crlf.txt' })));
    expect(screen.getByTestId('diff-path')).toHaveTextContent('a.txt');
    expect(screen.queryByRole('note')).toBeNull();
    await act(async () => release());
    expect(screen.getByTestId('diff-path')).toHaveTextContent('crlf.txt');
    expect(screen.getByRole('note')).toHaveTextContent('Only line endings changed');
    host.showDiff.mockImplementation(async () => {});
  });

  it('a thin progress line shows after ~150 ms while a diff computes or loads, and goes once it is on screen', async () => {
    // Fake timers (setTimeout only), so "~150 ms" is exact and no real clock or machine load matters.
    // RTL's waitFor/findBy poll on setTimeout, so this test advances the fake clock by hand instead.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      let release!: () => void;
      host.showDiff.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
      const { store } = renderPanel(targetFor(change('a.txt'), spec), (k) => (k.includes('slow.txt') ? new Promise<DiffContentsPayload>(() => {}) : text()));
      for (let i = 0; i < 50 && !host.showDiff.mock.calls.length; i++) await tick(0);
      expect(host.showDiff).toHaveBeenCalled();
      await tick(BUSY_DELAY - 10);
      expect(screen.queryByRole('progressbar')).toBeNull();
      await tick(10);
      expect(screen.getByRole('progressbar', { name: 'Loading diff' })).toBeInTheDocument();
      await act(async () => release());
      await tick(0);
      expect(screen.queryByRole('progressbar')).toBeNull();
      // A slow switch (contents still loading) shows it too, while the previous file stays.
      act(() => store.getState().openFile(targetFor(change('slow.txt'), spec)));
      await tick(BUSY_DELAY - 10);
      expect(screen.queryByRole('progressbar')).toBeNull();
      await tick(10);
      expect(screen.getByRole('progressbar', { name: 'Loading diff' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed showDiff releases the header, shows the error with Retry, and leaves no unhandled rejection', async () => {
    const a = targetFor(change('a.txt'), spec);
    const b = targetFor(change('b.txt'), spec);
    const { store } = renderPanel(a, async (k) => (k.includes('b.txt') ? contents(blob('b1\n'), blob('b2\n')) : contents(blob('a1\n'), blob('a2\n'))));
    // Generous waits (3 s, not the 1 s default): this failed once in a full run on a loaded machine.
    await waitFor(() => expect(button('Next change')).toBeEnabled(), { timeout: 3000 });
    // The toolbar enables once a.txt's contents are in, which can be before the editor host has
    // loaded and asked for a.txt's show: the rejection below is for b.txt's show, so wait for a's.
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.txt' })), { timeout: 3000 });
    host.showDiff.mockRejectedValueOnce(new Error('grammar failed'));
    act(() => store.getState().openFile(b));
    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent("Couldn't show this file: grammar failed");
    expect(screen.getByTestId('diff-path')).toHaveTextContent('b.txt');
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 3000 });
    expect(host.showDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'b.txt' }));
    expect(host.showDiff.mock.calls.filter(([r]) => r.path === 'b.txt')).toHaveLength(2);
    expect(screen.getByTestId('text-diff')).toBeVisible();
  });

  it('a failed showFile shows the error too', async () => {
    host.showFile.mockRejectedValueOnce(new Error('model failed'));
    renderPanel(fileViewTarget('a.txt', spec.id, spec), async () => contents(null, blob('a\n')));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't show this file: model failed");
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(host.showFile).toHaveBeenCalledTimes(2);
  });

  it('an unchanged file from View all files opens in File View, with Diff View disabled', async () => {
    const target = fileViewTarget('latin1.txt', spec.id, spec);
    renderPanel(target, async () => contents(null, blob('café crème brûlée\n', 'ISO-8859-1')));
    expect(await screen.findByTestId('file-view')).toBeInTheDocument();
    expect(screen.getByTestId('diff-encoding')).toHaveTextContent('ISO-8859-1');
    await waitFor(() => expect(host.showFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'latin1.txt', text: 'café crème brûlée\n', language: 'plaintext' })));
    expect(host.attachFile.mock.invocationCallOrder[0]).toBeLessThan(host.showFile.mock.invocationCallOrder[0]);
    expect(host.showDiff).not.toHaveBeenCalled();
    expect(button('File View')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Diff View')).toBeDisabled();
    for (const name of ['Previous change', 'Next change', 'Hunk', 'Inline', 'Split', /Ignore whitespace/]) expect(button(name)).toBeDisabled();
    expect(button('Word wrap')).toBeEnabled();
  });

  it('asks before loading a large file, then loads it with force', async () => {
    const big = (force: boolean) => contents(sized({ size: 3_000_000, text: force ? 'a\n' : null }), sized({ size: 3_000_001, text: force ? 'b\n' : null }), { tooLarge: !force });
    const { fetch } = renderPanel(targetFor(change('big.txt'), spec), async (key) => big(JSON.parse(key).force as boolean));
    expect(await screen.findByText('Large file — load anyway?')).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '2.9 MB → 2.9 MB').querySelector('svg.lucide-arrow-right')).not.toBeNull();
    expect(screen.queryByTestId('text-diff')).toBeNull();
    fireEvent.click(button('Load anyway'));
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ original: 'a\n', modified: 'b\n' })));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a side over the forced ceiling ends at a message: no second "Load anyway" that does nothing', async () => {
    const huge = contents(sized({ size: 70_000_000, text: null }), sized({ size: 70_000_001, text: null }), { tooLarge: true });
    const { fetch } = renderPanel(targetFor(change('huge.txt'), spec), async () => huge);
    fireEvent.click(await screen.findByRole('button', { name: 'Load anyway' }));
    expect(await screen.findByText('Too large to show — over 64 MB per side')).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '66.8 MB → 66.8 MB')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load anyway' })).toBeNull();
    expect(fetch.mock.calls.map(([k]) => JSON.parse(k).force)).toEqual([false, true]);
  });

  it('Previous/Next change and F7 only act while a text diff is shown', async () => {
    const cases: [string, (key: string) => Promise<DiffContentsPayload>][] = [
      ['loading.txt', () => new Promise<DiffContentsPayload>(() => {})],
      ['big.txt', async () => contents(sized({ size: 3_000_000, text: null }), sized({ size: 3_000_000, text: null }), { tooLarge: true })],
      ['gone.txt', async () => { throw new Error('object not found'); }],
    ];
    for (const [path, load] of cases) {
      const { view } = renderPanel(targetFor(change(path), spec), load);
      if (path !== 'loading.txt') await screen.findByText(/Large file|object not found/);
      expect(button('Previous change')).toBeDisabled();
      expect(button('Next change')).toBeDisabled();
      // Not captured: F7 is left to whatever else wants it.
      expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' })).toBe(true);
      view.unmount();
    }
    await Promise.resolve();
    expect(host.goToChange).not.toHaveBeenCalled();
  });

  it('a binary shows its hex view side by side, with its sizes in the file bar; F7 steps its changes; no view mode', async () => {
    renderPanel(targetFor(change('data.bin'), spec), async () => contents(sized({ binary: true, text: null, size: 9 }), sized({ binary: true, text: null, size: 10 })));
    expect(await screen.findByTestId('binary-summary')).toHaveTextContent('Binary · 9 bytes → 10 bytes');
    await waitFor(() => expect(host.hexShow).toHaveBeenCalledWith({ path: 'data.bin', file: false, old: { size: 9, shown: 9, dump: 'object old\n' }, new: { size: 9, shown: 9, dump: 'object new\n' } }));
    expect(screen.getByTestId('hex-view')).toBeInTheDocument();
    // Not the diff editor: the hex view has editors of its own.
    expect(screen.queryByTestId('text-diff')).toBeNull();
    expect(host.showDiff).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hex-capped')).toBeNull();
    // Always side by side: the view mode is off (the Inline button says why), and so are whitespace and wrapping.
    for (const name of ['Hunk', 'Inline', 'Split']) expect(button(name)).toHaveAttribute('aria-disabled', 'true');
    expect(button('Ignore whitespace')).toBeDisabled();
    expect(button('Word wrap')).toBeDisabled();
    fireEvent.mouseEnter(button('Inline'));
    expect(await screen.findByText(BINARY_MODE_TIP)).toBeInTheDocument();
    fireEvent.mouseLeave(button('Inline'));
    await waitFor(() => expect(button('Next change')).toBeEnabled());
    expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' })).toBe(false);
    await waitFor(() => expect(host.goToChange).toHaveBeenCalledWith('next'));
  });

  it('hex dumps loaded with the contents show at once, header and body together (no second load)', async () => {
    const a = targetFor(change('a.txt'), spec);
    const b = targetFor(change('pre.bin'), spec);
    const hex = { old: { size: 9, shown: 9, dump: 'pre old\n' }, new: { size: 10, shown: 10, dump: 'pre new\n' }, cap: 262144 };
    const { store } = renderPanel(a, async (k) => (k.includes('pre.bin') ? { ...contents(sized({ binary: true, text: null }), sized({ binary: true, text: null })), hex } : contents(blob('a1\n'), blob('a2\n'))));
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.txt' })));
    act(() => store.getState().openFile(b));
    await waitFor(() => expect(host.hexShow).toHaveBeenLastCalledWith({ path: 'pre.bin', file: false, old: hex.old, new: hex.new }));
    // Shown in the render that presents it: the header names it already, nothing waits.
    expect(screen.getByTestId('diff-path')).toHaveTextContent('pre.bin');
    expect(screen.queryByTestId('text-diff')).toBeNull();
    expect(hexDump).not.toHaveBeenCalled();
  });

  it('a failed load shows an alert, and so does a failed hex dump', async () => {
    const { view } = renderPanel(targetFor(change('gone.txt'), spec), async () => { throw new Error('object not found'); });
    expect(await screen.findByRole('alert')).toHaveTextContent('object not found');
    view.unmount();
    hexDump.mockRejectedValueOnce(new Error('cat-file failed'));
    renderPanel(targetFor(change('broken.bin'), spec), async () => contents(sized({ binary: true, text: null }), sized({ binary: true, text: null })));
    expect(await screen.findByRole('alert')).toHaveTextContent('cat-file failed');
  });

  it('an added binary shows its one side and reads "(added)"; File View shows that side', async () => {
    renderPanel(targetFor({ ...change('new.bin', 'A'), old: { kind: 'absent' } }, spec), async () => contents(null, sized({ binary: true, text: null, size: 2048 })));
    expect(await screen.findByTestId('binary-summary')).toHaveTextContent('Binary · 2 KB (added)');
    expect(screen.getByTestId('binary-summary')).not.toHaveTextContent('—');
    const added = { size: 9, shown: 9, dump: 'object new\n' };
    await waitFor(() => expect(host.hexShow).toHaveBeenCalledWith({ path: 'new.bin', file: false, old: null, new: added }));
    fireEvent.click(button('File View'));
    await waitFor(() => expect(host.hexShow).toHaveBeenLastCalledWith({ path: 'new.bin', file: true, old: null, new: added }));
    expect(host.showFile).not.toHaveBeenCalled();
    expect(screen.getByTestId('binary-summary')).toHaveTextContent(/^Binary · 2 KB$/);
  });

  it('a binary past the hex cap says only its start is shown, with the cap the dumps came with', async () => {
    hexDump.mockResolvedValueOnce({ old: { size: 1000, shown: 1000, dump: 'a\n' }, new: { size: 4.2 * 1024 * 1024, shown: 128 * 1024, dump: 'b\n' }, cap: 128 * 1024 });
    renderPanel(targetFor(change('big.bin'), spec), async () => contents(sized({ binary: true, text: null, size: 1000 }), sized({ binary: true, text: null, size: 4.2 * 1024 * 1024 })));
    expect(await screen.findByTestId('hex-capped')).toHaveTextContent('Showing the first 128 KB of 4.2 MB');
  });

  it('a binary of any size goes straight to its hex dump: no large-file prompt, no "too large"', async () => {
    // What the core sends for a 70 MB binary: not `tooLarge` (its first bytes said binary), and its dumps capped.
    const size = 70 * 1024 * 1024;
    const hex = { old: null, new: { size, shown: 262144, dump: '00000000  00 00\n' }, cap: 262144 };
    renderPanel(targetFor({ ...change('huge.bin', 'A'), old: { kind: 'absent' } }, spec), async () => ({ ...contents(null, sized({ binary: true, encoding: '', text: null, hash: null, size })), hex }));
    expect(await screen.findByTestId('hex-capped')).toHaveTextContent('Showing the first 256 KB of 70 MB');
    expect(screen.getByTestId('binary-summary')).toHaveTextContent('Binary · 70 MB (added)');
    await waitFor(() => expect(host.hexShow).toHaveBeenCalledWith({ path: 'huge.bin', file: false, old: null, new: hex.new }));
    expect(screen.queryByText(/Large file|Too large/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load anyway' })).toBeNull();
  });

  it('shows the EOL banner and captures F7 / Shift+F7 before the editor sees them', async () => {
    renderPanel(targetFor(change('crlf.txt'), spec), async () => contents(sized({ eol: 'crlf', text: 'a\r\n' }), sized({ text: 'a\n' }), { eolOnly: true }));
    expect(await screen.findByRole('note')).toHaveTextContent('Only line endings changed (CRLF → LF)');
    // F7 acts once the diff is on screen (the host resolved `showDiff`), as the toolbar does.
    await waitFor(() => expect(button('Next change')).toBeEnabled());
    const region = screen.getByRole('region', { name: 'Diff' });
    // `false`: the default is prevented (Monaco's own F7 opens its accessible diff viewer).
    expect(fireEvent.keyDown(region, { key: 'F7' })).toBe(false);
    expect(fireEvent.keyDown(region, { key: 'F7', shiftKey: true })).toBe(false);
    await waitFor(() => expect(host.goToChange.mock.calls).toEqual([['next'], ['previous']]));
  });

  describe('change keys, app-wide (J14)', () => {
    /** An element outside the panel (the file list, the graph, …) with the keyboard. */
    const outside = (html = '<button type="button">file row</button>') => {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.append(host);
      const el = host.querySelector<HTMLElement>('button, textarea, input')!;
      el.focus();
      return { el, remove: () => host.remove() };
    };
    const openText = async () => {
      const r = renderPanel(targetFor(change('a.txt'), spec), text);
      await waitFor(() => expect(button('Next change')).toBeEnabled());
      return r;
    };
    const press = (el: Element, key: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => fireEvent.keyDown(el, { key, ...mods });

    it('F7 / Shift+F7 step the changes whatever has the keyboard, the file list included', async () => {
      await openText();
      const { el, remove } = outside();
      expect(el).toHaveFocus();
      expect(press(el, 'F7')).toBe(false);
      expect(press(el, 'F7', { shiftKey: true })).toBe(false);
      expect(press(document.body, 'F7')).toBe(false);
      await waitFor(() => expect(host.goToChange.mock.calls).toEqual([['next'], ['previous'], ['next']]));
      remove();
    });

    it('Shift+↓ / Shift+↑ step the changes outside the editor; plain ↑/↓ and other chords are left alone', async () => {
      await openText();
      const { el, remove } = outside();
      expect(press(el, 'ArrowDown', { shiftKey: true })).toBe(false);
      expect(press(el, 'ArrowUp', { shiftKey: true })).toBe(false);
      // Plain ↑/↓ still switch files; Ctrl/Alt chords are someone else's.
      expect(press(el, 'ArrowDown')).toBe(true);
      expect(press(el, 'ArrowUp', { shiftKey: true, ctrlKey: true })).toBe(true);
      expect(press(el, 'ArrowDown', { shiftKey: true, altKey: true })).toBe(true);
      await waitFor(() => expect(host.goToChange.mock.calls).toEqual([['next'], ['previous']]));
      remove();
    });

    it('Shift+↑/↓ inside the editor (or a text field) extend the selection, as usual', async () => {
      await openText();
      const editor = outside('<div class="monaco-editor"><textarea class="inputarea"></textarea></div>');
      expect(press(editor.el, 'ArrowDown', { shiftKey: true })).toBe(true);
      expect(press(editor.el, 'ArrowUp', { shiftKey: true })).toBe(true);
      // F7 there still steps (Monaco's own F7 is its accessible diff viewer).
      expect(press(editor.el, 'F7')).toBe(false);
      editor.remove();
      const input = outside('<input type="text" />');
      expect(press(input.el, 'ArrowDown', { shiftKey: true })).toBe(true);
      input.remove();
      await waitFor(() => expect(host.goToChange.mock.calls).toEqual([['next']]));
    });

    // An image diff: the "images" tests below.
    it('none of them act for File View, or once the panel is gone', async () => {
      const file = renderPanel(fileViewTarget('a.txt', spec.id, spec), async () => contents(null, blob('a\n')));
      await screen.findByTestId('file-view');
      const list = outside();
      for (const [key, shiftKey] of [['F7', false], ['F7', true], ['ArrowDown', true], ['ArrowUp', true]] as const) expect(press(list.el, key, { shiftKey })).toBe(true);
      list.remove();
      file.view.unmount();
      const { view } = await openText();
      view.unmount();
      const { el, remove } = outside();
      expect(press(el, 'F7')).toBe(true);
      expect(press(el, 'ArrowDown', { shiftKey: true })).toBe(true);
      remove();
      await Promise.resolve();
      expect(host.goToChange).not.toHaveBeenCalled();
    });
  });

  it('F7 is left alone in File View', async () => {
    renderPanel(fileViewTarget('a.txt', spec.id, spec), async () => contents(null, blob('a\n')));
    await screen.findByTestId('file-view');
    expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' })).toBe(true);
    await Promise.resolve();
    expect(host.goToChange).not.toHaveBeenCalled();
  });

  it('the toolbar: Inline is pressed by default, and every pick applies and persists', async () => {
    renderPanel(targetFor(change('a.txt'), spec), text);
    expect(screen.getByRole('toolbar', { name: 'Diff options' })).toBeInTheDocument();
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    expect(button('Diff View')).toHaveAttribute('aria-pressed', 'true');
    expect(button('File View')).toHaveAttribute('aria-pressed', 'false');
    expect(['Hunk', 'Inline', 'Split'].map((n) => button(n).getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    fireEvent.click(button('Split'));
    expect(['Hunk', 'Inline', 'Split'].map((n) => button(n).getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    expect(host.setDiffPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'split' }));
    fireEvent.click(button(/Ignore whitespace/));
    fireEvent.click(button('Word wrap'));
    expect(button(/Ignore whitespace/)).toHaveAttribute('aria-pressed', 'true');
    expect(button('Word wrap')).toHaveAttribute('aria-pressed', 'true');
    expect(host.setDiffPrefs).toHaveBeenLastCalledWith({ mode: 'split', ignoreWhitespace: true, wordWrap: true, markdownView: 'rendered', historyView: 'file' });
    expect(JSON.parse(localStorage.getItem(DIFF_PREFS_STORAGE_KEY)!)).toEqual({ mode: 'split', ignoreWhitespace: true, wordWrap: true, markdownView: 'rendered', historyView: 'file' });
    fireEvent.click(button('Hunk'));
    expect(useDiffPrefs.getState().prefs.mode).toBe('hunk');
    // No placeholder UI (plan 1B global constraints); Blame | History are #3's real buttons.
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  });

  it("the toolbar layout (H9): File/Diff View centred; then Blame | History, prev/next, the modes and the toggles on the right", async () => {
    renderPanel(targetFor(change('a.txt'), spec), text);
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    const bar = screen.getByRole('toolbar', { name: 'Diff options' });
    const names = [...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual(['File View', 'Diff View', 'Blame', 'History', 'Previous change', 'Next change', 'Hunk', 'Inline', 'Split', 'Ignore whitespace', 'Word wrap']);
    expect(bar.querySelector('.diff-toolbar-end')).toContainElement(button('Previous change'));
    // Prev/next are arrow icons with a hover tooltip, like the toggles (no native title).
    for (const [name, tip] of [['Previous change', 'Previous change (Shift+F7)'], ['Next change', 'Next change (F7)']]) {
      const b = button(name);
      expect(b).not.toHaveAttribute('title');
      expect(b.querySelector('svg')).not.toBeNull();
      fireEvent.mouseEnter(b);
      expect(screen.getByRole('tooltip')).toHaveTextContent(tip);
      fireEvent.mouseLeave(b);
    }
  });

  it("the toolbar's leading slot sits at its far left, before File/Diff View; the header has none (J1: Open in…)", () => {
    const target = targetFor(change('src/app.php'), spec);
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const inStore = (ui: ReactNode) => render(<RepoViewContext value={store}>{ui}</RepoViewContext>);
    inStore(<DiffToolbar target={target} canDiff canStep textTools leading={<button type="button">Open in</button>} />);
    const bar = screen.getByRole('toolbar', { name: 'Diff options' });
    const slot = button('Open in');
    expect(bar.firstElementChild).toHaveClass('diff-toolbar-start');
    expect(bar.firstElementChild).toContainElement(slot);
    expect(slot.compareDocumentPosition(button('File View')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // An image diff hides the text tools, not the slot.
    inStore(<DiffToolbar target={target} canDiff canStep={false} textTools={false} leading={<button type="button">Open image</button>} />);
    expect(screen.getAllByRole('toolbar', { name: 'Diff options' })[1].firstElementChild).toContainElement(button('Open image'));
    render(<DiffHeader target={target} encoding="" onClose={() => {}} />);
    expect(document.querySelector('.diff-header-leading')).toBeNull();
    // K5/K6: the details header's bar box (tokens.css), so their dividers line up.
    expect(document.querySelector('.diff-header')).toHaveClass('panel-bar');
  });

  it('a rename shows the common base, then old ⇒ new with only the new name highlighted; the tooltip stacks both paths (H21)', () => {
    const target = { ...targetFor({ ...change('docs/manual.txt', 'R'), oldPath: 'docs/guide.txt' }, spec) };
    render(<DiffHeader target={target} encoding="" onClose={() => {}} />);
    const path = screen.getByTestId('diff-path');
    expect(path).toHaveTextContent(/^docs\/guide\.txt ⇒ manual\.txt$/);
    expect([...path.querySelectorAll('strong')].map((s) => s.textContent)).toEqual(['manual.txt']);
    expect(path).not.toHaveAttribute('title');
    fireEvent.mouseEnter(path);
    const lines = [...within(screen.getByRole('tooltip')).getByTestId('rename-paths').children].map((l) => l.textContent);
    expect(lines).toEqual(['docs/guide.txt', '↓', 'docs/manual.txt']);
    fireEvent.mouseLeave(path);
    // Not a rename: the full path in the tooltip.
    render(<DiffHeader target={targetFor(change('src/app.php'), spec)} encoding="" onClose={() => {}} />);
    const plain = screen.getAllByTestId('diff-path')[1];
    fireEvent.mouseEnter(plain);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^src\/app\.php$/);
  });

  it('Ignore whitespace and Word wrap are icon-only toggles, named for screen readers and in a hover tooltip', async () => {
    renderPanel(targetFor(change('a.txt'), spec), text);
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    for (const [name, tip] of [['Ignore whitespace', 'Ignore leading and trailing whitespace'], ['Word wrap', 'Word wrap']]) {
      const b = button(name);
      expect(b).toHaveTextContent(/^$/);
      expect(b.querySelector('svg')).not.toBeNull();
      expect(b).not.toHaveAttribute('title');
      fireEvent.mouseEnter(b);
      expect(screen.getByRole('tooltip')).toHaveTextContent(tip);
      fireEvent.mouseLeave(b);
      expect(screen.queryByRole('tooltip')).toBeNull();
    }
  });

  it('Previous change / Next change move through the diff; mouse-down on the toolbar never takes focus', async () => {
    renderPanel(targetFor(change('a.txt'), spec), text);
    await waitFor(() => expect(button('Next change')).toBeEnabled());
    expect(fireEvent.mouseDown(button('Next change'))).toBe(false);
    fireEvent.click(button('Next change'));
    fireEvent.click(button('Previous change'));
    await waitFor(() => expect(host.goToChange.mock.calls).toEqual([['next'], ['previous']]));
  });

  it('File View and Diff View switch the body; word wrap applies to both', async () => {
    const { store } = renderPanel(targetFor(change('a.txt'), spec), text);
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    fireEvent.click(button('File View'));
    expect(store.getState().diff?.view).toBe('file');
    expect(await screen.findByTestId('file-view')).toBeInTheDocument();
    await waitFor(() => expect(host.showFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.txt', text: 'b\n' })));
    expect(button('Next change')).toBeDisabled();
    fireEvent.click(button('Word wrap'));
    expect(host.setFileWordWrap).toHaveBeenLastCalledWith(true);
    fireEvent.click(button('Diff View'));
    expect(await screen.findByTestId('text-diff')).toBeInTheDocument();
    expect(host.setDiffPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ wordWrap: true }));
  });

  it('a click in the diff zone puts the keyboard in the editor; toolbar clicks do not', async () => {
    host.attachDiff.mockImplementation((el: HTMLElement) => {
      const inner = document.createElement('div');
      inner.className = 'monaco-host';
      el.appendChild(inner);
    });
    renderPanel(targetFor(change('a.txt'), spec), text);
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    fireEvent.click(button('Split'));
    fireEvent.click(screen.getByTestId('diff-path'));
    await waitFor(() => expect(host.focus).toHaveBeenCalledTimes(1));
    host.attachDiff.mockReset();
  });

  describe('images', () => {
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    let urls = 0;
    const create = vi.fn(() => `blob:img-${++urls}`);
    const revoke = vi.fn();
    beforeEach(() => {
      urls = 0;
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    });
    afterEach(() => {
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    });
    const png = (size: number): BlobPayload => sized({ binary: true, encoding: '', text: null, base64: 'iVBORw==', size });
    const svg = (body: string): BlobPayload => sized({ text: `<svg>${body}</svg>\n` });
    const layers = () => [...document.querySelectorAll<HTMLImageElement>('img.image-layer')].map((i) => i.alt);

    it('a raster image shows the image diff, not a binary summary; no text-diff controls, and F7 stays off (H26)', async () => {
      renderPanel(targetFor(change('logo.png'), spec), async () => contents(png(90), png(100), { image: true }));
      expect(await screen.findByRole('toolbar', { name: 'Image diff options' })).toBeInTheDocument();
      await waitFor(() => expect(layers()).toEqual(['before', 'after']));
      expect(screen.getByTestId('image-size')).toHaveTextContent('90 B → 100 B');
      expect(screen.queryByTestId('binary-summary')).toBeNull();
      expect(screen.queryByTestId('text-diff')).toBeNull();
      // Prev/next, the modes and the toggles don't apply to an image (H26); File/Diff View does.
      for (const name of ['Previous change', 'Next change', 'Hunk', 'Inline', 'Split', 'Ignore whitespace', 'Word wrap']) expect(screen.queryByRole('button', { name })).toBeNull();
      expect(button('File View')).toBeInTheDocument();
      expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' })).toBe(true);
      // Nor Shift+↑/↓ (J14), from anywhere.
      expect(fireEvent.keyDown(document.body, { key: 'ArrowDown', shiftKey: true })).toBe(true);
      expect(fireEvent.keyDown(document.body, { key: 'F7' })).toBe(true);
      await Promise.resolve();
      expect(host.goToChange).not.toHaveBeenCalled();
    });

    it('object URLs are built once per file, not on every render, and revoked when the file changes', async () => {
      const { store } = renderPanel(targetFor(change('logo.png'), spec), async () => contents(png(90), png(100), { image: true }));
      await waitFor(() => expect(layers()).toHaveLength(2));
      expect(create).toHaveBeenCalledTimes(2);
      // Re-renders of the panel (focus changes) and of the image diff (a mode switch) reuse the
      // loader's cached contents object, so the URLs stay.
      act(() => store.getState().setFocus('diff'));
      act(() => store.getState().setFocus('files'));
      fireEvent.click(button('Swipe'));
      expect(create).toHaveBeenCalledTimes(2);
      expect(revoke).not.toHaveBeenCalled();
      act(() => store.getState().openFile(targetFor(change('other.png', 'A'), spec)));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(4));
      expect(revoke.mock.calls.map(([u]) => u).sort()).toEqual(['blob:img-1', 'blob:img-2']);
    });

    it("an SVG shows as images, and its Source toggle shows the text diff, with the text diff's controls (H26)", async () => {
      renderPanel(targetFor(change('icon.svg'), spec), async () => contents(svg('<rect/>'), svg('<circle/>')));
      await waitFor(() => expect(layers()).toEqual(['before', 'after']));
      expect(screen.queryByTestId('text-diff')).toBeNull();
      expect(host.showDiff).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Hunk' })).toBeNull();
      fireEvent.click(button('Source'));
      expect(await screen.findByTestId('text-diff')).toBeInTheDocument();
      await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'icon.svg', original: '<svg><rect/></svg>\n', modified: '<svg><circle/></svg>\n', language: 'xml' })));
      for (const name of ['Hunk', 'Inline', 'Split', 'Ignore whitespace', 'Word wrap']) expect(button(name)).toBeEnabled();
      await waitFor(() => expect(button('Next change')).toBeEnabled());
      expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' })).toBe(false);
      await waitFor(() => expect(host.goToChange).toHaveBeenCalledWith('next'));
      // Source off again: an image, no text controls.
      fireEvent.click(button('Source'));
      expect(screen.queryByRole('button', { name: 'Hunk' })).toBeNull();
    });

    it("SVG A with Source on, then file B, then back to A: A opens as an image, with no text tools (H26)", async () => {
      const a = targetFor(change('a.svg'), spec);
      const b = targetFor(change('b.svg'), spec);
      const { store } = renderPanel(a, async () => contents(svg('<rect/>'), svg('<circle/>')));
      await waitFor(() => expect(layers()).toHaveLength(2));
      fireEvent.click(button('Source'));
      await waitFor(() => expect(button('Next change')).toBeEnabled());
      act(() => store.getState().openFile(b));
      await waitFor(() => expect(screen.getByTestId('diff-path')).toHaveTextContent('b.svg'));
      act(() => store.getState().openFile(a));
      await waitFor(() => expect(screen.getByTestId('diff-path')).toHaveTextContent('a.svg'));
      await waitFor(() => expect(layers()).toHaveLength(2));
      expect(button('Source')).toHaveAttribute('aria-pressed', 'false');
      for (const name of ['Previous change', 'Next change', 'Hunk', 'Inline', 'Split', 'Ignore whitespace', 'Word wrap']) expect(screen.queryByRole('button', { name })).toBeNull();
      host.goToChange.mockClear();
      expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' })).toBe(true);
      await Promise.resolve();
      expect(host.goToChange).not.toHaveBeenCalled();
    });

    it('File View shows the image at that revision only; its SVG source is the file, not a diff', async () => {
      renderPanel(targetFor(change('icon.svg'), spec), async () => contents(svg('<rect/>'), svg('<circle/>')));
      await waitFor(() => expect(layers()).toHaveLength(2));
      fireEvent.click(button('File View'));
      await waitFor(() => expect(layers()).toEqual(['after']));
      // One revision: just its own size, unlabelled (H25).
      expect(screen.getByTestId('image-meta')).not.toHaveTextContent(/—|→|added|deleted/);
      fireEvent.click(button('Source'));
      expect(await screen.findByTestId('file-view')).toBeInTheDocument();
      await waitFor(() => expect(host.showFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'icon.svg', text: '<svg><circle/></svg>\n' })));
      expect(host.showDiff).not.toHaveBeenCalled();
    });

    it('a format change (shot.png → shot.svg) asks with its old path and shows each side as its own type', async () => {
      const rename: FileChange = { ...change('img/shot.svg', 'R'), oldPath: 'img/shot.png' };
      const { fetch } = renderPanel(targetFor(rename, spec), async () => contents(png(90), svg('<rect/>'), { image: true }));
      await waitFor(() => expect(layers()).toEqual(['before', 'after']));
      expect(JSON.parse(fetch.mock.calls[0][0])).toMatchObject({ path: 'img/shot.svg', oldPath: 'img/shot.png' });
      expect((create.mock.calls as unknown as [Blob][]).map(([b]) => b.type)).toEqual(['image/png', 'image/svg+xml']);
    });

    it('a binary SVG side has no image bytes, so it shows as hex', async () => {
      renderPanel(targetFor(change('odd.svg'), spec), async () => contents(svg('<rect/>'), sized({ binary: true, encoding: '', text: null, size: 12 })));
      expect(await screen.findByTestId('binary-summary')).toHaveTextContent('Binary · 10 bytes → 12 bytes');
      await waitFor(() => expect(host.hexShow).toHaveBeenCalledWith(expect.objectContaining({ path: 'odd.svg', file: false })));
      expect(create).not.toHaveBeenCalled();
    });

    it('a raster image has a Hex toggle: its hex diff, with the diff controls', async () => {
      hexDump.mockResolvedValueOnce({ old: { size: 90, shown: 90, dump: 'object old\n' }, new: { size: 300_000, shown: 262144, dump: 'object new\n' }, cap: 262144 });
      renderPanel(targetFor(change('logo.png'), spec), async () => contents(png(90), png(300_000), { image: true }));
      await waitFor(() => expect(layers()).toEqual(['before', 'after']));
      expect(screen.queryByRole('button', { name: 'Source' })).toBeNull();
      fireEvent.click(button('Hex'));
      await waitFor(() => expect(host.hexShow).toHaveBeenCalledWith({ path: 'logo.png', file: false, old: expect.objectContaining({ dump: 'object old\n' }), new: expect.objectContaining({ dump: 'object new\n' }) }));
      expect(button('Next change')).toBeInTheDocument();
      // The image keeps its own sizes; the file bar only says the dump is cut.
      expect(screen.queryByTestId('binary-summary')).toBeNull();
      expect(screen.getByTestId('hex-capped')).toHaveTextContent('Showing the first 256 KB of 293 KB');
    });

    it('an added image in Diff View is labelled "(added)", with no compare modes (H25)', async () => {
      renderPanel(targetFor(change('new.png', 'A'), spec), async () => contents(null, png(100), { image: true }));
      await waitFor(() => expect(layers()).toEqual(['after']));
      expect(screen.getByTestId('image-meta')).toHaveTextContent(/100 B \(added\)$/);
      expect(screen.queryByRole('group', { name: 'Image mode' })).toBeNull();
    });

    it('a deleted image in File View shows its last revision', async () => {
      renderPanel(fileViewTarget('gone.png', spec.id, spec), async () => contents(png(90), null, { image: true }));
      await waitFor(() => expect(layers()).toEqual(['before']));
      expect(screen.getByTestId('image-meta')).not.toHaveTextContent(/—|→|added|deleted/);
    });
  });

  it('Esc is taken before the editor sees it and closes the file, unless an editor overlay (find) is open', async () => {
    let inner: HTMLElement | undefined;
    host.attachDiff.mockImplementation((el: HTMLElement) => {
      inner = document.createElement('div');
      inner.className = 'monaco-host';
      inner.innerHTML = '<div class="find-widget"></div><textarea class="inputarea"></textarea>';
      el.appendChild(inner);
    });
    const { store } = renderPanel(targetFor(change('a.txt'), spec), text);
    await waitFor(() => expect(inner).toBeDefined());
    const find = inner!.querySelector<HTMLElement>('.find-widget')!;
    const input = inner!.querySelector('textarea')!;
    // An open find widget (jsdom has no layout: give it a box) keeps Esc for Monaco.
    find.classList.add('visible');
    find.getClientRects = () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
    expect(store.getState().diff).not.toBeNull();
    find.classList.remove('visible');
    const seen = vi.fn();
    input.addEventListener('keydown', seen);
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(seen).not.toHaveBeenCalled();
    expect(store.getState().diff).toBeNull();
    host.attachDiff.mockReset();
  });

  it('Ctrl+W closes the file from inside the editor, even with an editor overlay (find) open', async () => {
    let inner: HTMLElement | undefined;
    host.attachDiff.mockImplementation((el: HTMLElement) => {
      inner = document.createElement('div');
      inner.className = 'monaco-host';
      inner.innerHTML = '<div class="find-widget visible"></div><textarea class="inputarea"></textarea>';
      el.appendChild(inner);
    });
    const { store } = renderPanel(targetFor(change('a.txt'), spec), text);
    // Ctrl+W is the app's shortcut (plan 1C), acting on the active tab's store: this one.
    const offKeys = installShortcuts();
    activeTabWith(store);
    await waitFor(() => expect(inner).toBeDefined());
    const find = inner!.querySelector<HTMLElement>('.find-widget')!;
    const input = inner!.querySelector('textarea')!;
    find.getClientRects = () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
    for (const mods of [{ shiftKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(fireEvent.keyDown(input, { key: 'w', ctrlKey: true, ...mods })).toBe(true);
    }
    expect(store.getState().diff).not.toBeNull();
    const seen = vi.fn();
    input.addEventListener('keydown', seen);
    // The find widget is open: Ctrl+W still closes. By character: Dvorak's W (on Comma) works.
    expect(fireEvent.keyDown(input, { key: 'w', code: 'Comma', ctrlKey: true })).toBe(false);
    expect(seen).not.toHaveBeenCalled();
    expect(store.getState().diff).toBeNull();
    offKeys();
    host.attachDiff.mockReset();
  });

  it("Esc is left to the editor while its context menu, a hover or the suggest widget is open, wherever it's mounted", async () => {
    let inner: HTMLElement | undefined;
    host.attachDiff.mockImplementation((el: HTMLElement) => {
      inner = document.createElement('div');
      inner.className = 'monaco-host';
      inner.innerHTML = '<textarea class="inputarea"></textarea>';
      el.appendChild(inner);
    });
    const { store } = renderPanel(targetFor(change('a.txt'), spec), text);
    await waitFor(() => expect(inner).toBeDefined());
    const input = inner!.querySelector('textarea')!;
    // jsdom has no layout: a shown overlay gets a box, a hidden one (display: none) has none.
    const overlay = (html: string, parent: HTMLElement, shown: boolean) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      const el = wrap.firstElementChild as HTMLElement;
      el.getClientRects = () => (shown ? [new DOMRect(0, 0, 100, 20)] : []) as unknown as DOMRectList;
      parent.appendChild(el);
      return el;
    };
    const cases: [string, HTMLElement][] = [
      ['<div class="context-view monaco-menu-container"><div class="monaco-menu"></div></div>', inner!],
      ['<div class="context-view"><div class="monaco-menu-container"></div></div>', document.body],
      ['<div class="monaco-resizable-hover"><div class="monaco-hover"></div></div>', inner!],
      ['<div class="editor-widget suggest-widget visible"></div>', inner!],
    ];
    // Monaco's context view renders inside an open shadow root (`useShadowDOM`, on by default).
    const shadowHost = document.createElement('div');
    shadowHost.className = 'shadow-root-host';
    inner!.appendChild(shadowHost);
    cases.push(['<div class="context-view monaco-menu-container"></div>', shadowHost.attachShadow({ mode: 'open' }) as unknown as HTMLElement]);
    for (const [html, parent] of cases) {
      const el = overlay(html, parent, true);
      el.querySelectorAll<HTMLElement>('*').forEach((c) => { c.getClientRects = el.getClientRects; });
      expect(fireEvent.keyDown(input, { key: 'Escape' }), html).toBe(true);
      expect(store.getState().diff, html).not.toBeNull();
      el.remove();
    }
    // Hidden ones don't count: a closed hover (`.hidden`), a context view with no box, a suggest
    // widget that isn't `.visible`.
    overlay('<div class="monaco-hover hidden"></div>', inner!, true);
    overlay('<div class="context-view"></div>', document.body, false);
    overlay('<div class="suggest-widget"></div>', inner!, true);
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(store.getState().diff).toBeNull();
    document.querySelectorAll('.context-view').forEach((e) => e.remove());
    host.attachDiff.mockReset();
  });

  it("G.2: a staged file's File View loads its working-tree file, editable; unsaved edits hold every reload", async () => {
    const f: FileChange = { ...change('a.txt'), new: { kind: 'object', oid: 'i'.repeat(40) } };
    const target: DiffTarget = { ...targetFor(f, { kind: 'wip', worktree: '/r', staged: true }), view: 'file' };
    const fetch = vi.fn(async (_k: string) => contents(blob('a\n'), { ...blob('wt\n'), hash: 'h0' }));
    // Working-tree contents are never cached (`isMutableKey`), as in `createServices`.
    const loader = new Loader(fetch, new Lru<string, DiffContentsPayload>(10), 4, (k) => !isMutableKey(k));
    const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents: loader }));
    act(() => store.getState().openFile(target));
    render(<RepoViewContext value={store}><DiffPanel target={target} /></RepoViewContext>);
    await waitFor(() => expect(host.showFile).toHaveBeenCalledWith(expect.objectContaining({ text: 'wt\n' })));
    expect((JSON.parse(fetch.mock.calls[0]![0]) as { new: unknown }).new).toEqual({ kind: 'worktree', worktree: '/r' });
    await waitFor(() => expect(host.setFileEditable).toHaveBeenLastCalledWith(true));
    expect(useWorkingCopy.getState().copies['']).toMatchObject({ path: 'a.txt', worktree: '/r', base: 'h0', view: 'file', dirty: false });
    // Dirty: a reload (a watcher refresh, here the epoch) doesn't read the file again.
    act(() => useWorkingCopy.setState((s) => ({ copies: { ...s.copies, '': { ...s.copies['']!, dirty: true } } })));
    const calls = fetch.mock.calls.length;
    act(() => useWorkingCopy.setState({ epoch: { '': 1 } }));
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(calls);
    // Saved (clean again): the held reload goes.
    act(() => useWorkingCopy.setState((s) => ({ copies: { ...s.copies, '': { ...s.copies['']!, dirty: false } } })));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(calls + 1));
    act(() => useWorkingCopy.setState({ copies: {}, epoch: {} }));
  });

  it('← in the diff zone moves the focus to the files', async () => {
    const { store } = renderPanel(targetFor(change('a.txt'), spec), text);
    act(() => store.getState().setFocus('diff'));
    const region = screen.getByRole('region', { name: 'Diff' });
    expect(fireEvent.keyDown(region, { key: 'ArrowLeft' })).toBe(false);
    expect(store.getState().focus).toBe('files');
  });
});
