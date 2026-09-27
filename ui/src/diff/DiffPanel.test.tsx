import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { contentKey } from '../repo/services';
import { contentsRequest, createRepoViewStore, fileViewTarget, RepoViewContext, targetFor, useRepoView, type DiffTarget } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { DiffPanel } from './DiffPanel';
import { DEFAULT_DIFF_PREFS, DIFF_PREFS_STORAGE_KEY, useDiffPrefs } from './diffPrefs';

const host = vi.hoisted(() => ({
  attachDiff: vi.fn(), detachDiff: vi.fn(), showDiff: vi.fn(async () => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(),
  setContextMenuHandler: vi.fn(), layout: vi.fn(),
}));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false };
const spec = { kind: 'commit' as const, id: 'c'.repeat(40), parent: 0 };
const blob = (text: string | null, encoding = 'UTF-8', binary = false): BlobPayload => ({ size: text?.length ?? 8, binary, encoding, eol: 'lf', text, base64: null });
const sized = (p: Partial<BlobPayload>): BlobPayload => ({ size: 10, binary: false, encoding: 'UTF-8', eol: 'lf', text: 'x\n', base64: null, ...p });
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
    return diff && <DiffPanel target={diff} />;
  };
  const view = render(<RepoViewContext value={store}><Connected /></RepoViewContext>);
  return { store, loader, fetch, view };
}
const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('DiffPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS });
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
    expect(screen.getByText('2.9 MB → 2.9 MB')).toBeInTheDocument();
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
    expect(screen.getByText('66.8 MB → 66.8 MB')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load anyway' })).toBeNull();
    expect(fetch.mock.calls.map(([k]) => JSON.parse(k).force)).toEqual([false, true]);
  });

  it('Previous/Next change and F7 only act while a text diff is shown', async () => {
    const cases: [string, (key: string) => Promise<DiffContentsPayload>][] = [
      ['loading.txt', () => new Promise<DiffContentsPayload>(() => {})],
      ['big.txt', async () => contents(sized({ size: 3_000_000, text: null }), sized({ size: 3_000_000, text: null }), { tooLarge: true })],
      ['data.bin', async () => contents(sized({ binary: true, text: null }), sized({ binary: true, text: null }))],
      ['gone.txt', async () => { throw new Error('object not found'); }],
    ];
    for (const [path, load] of cases) {
      const { view } = renderPanel(targetFor(change(path), spec), load);
      if (path !== 'loading.txt') await screen.findByText(/Large file|Binary file|object not found/);
      expect(button('Previous change')).toBeDisabled();
      expect(button('Next change')).toBeDisabled();
      // Not captured: F7 is left to whatever else wants it.
      expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' })).toBe(true);
      view.unmount();
    }
    await Promise.resolve();
    expect(host.goToChange).not.toHaveBeenCalled();
  });

  it('summarizes binary files, and a failed load shows an alert', async () => {
    renderPanel(targetFor(change('data.bin'), spec), async () => contents(sized({ binary: true, text: null, size: 9 }), sized({ binary: true, text: null, size: 10 })));
    expect(await screen.findByTestId('binary-summary')).toHaveTextContent('Binary file · 9 B → 10 B');
    expect(screen.queryByTestId('text-diff')).toBeNull();
    renderPanel(targetFor(change('gone.txt'), spec), async () => { throw new Error('object not found'); });
    expect(await screen.findByRole('alert')).toHaveTextContent('object not found');
  });

  it('a binary file added in this commit reads — for the absent side', async () => {
    renderPanel(targetFor(change('new.bin', 'A'), spec), async () => contents(null, sized({ binary: true, text: null, size: 2048 })));
    expect(await screen.findByTestId('binary-summary')).toHaveTextContent('Binary file · — → 2.0 KB');
  });

  it('shows the EOL banner and captures F7 / Shift+F7 before the editor sees them', async () => {
    renderPanel(targetFor(change('crlf.txt'), spec), async () => contents(sized({ eol: 'crlf', text: 'a\r\n' }), sized({ text: 'a\n' }), { eolOnly: true }));
    expect(await screen.findByRole('note')).toHaveTextContent('Only line endings changed (CRLF → LF)');
    const region = screen.getByRole('region', { name: 'Diff' });
    // `false`: the default is prevented (Monaco's own F7 opens its accessible diff viewer).
    expect(fireEvent.keyDown(region, { key: 'F7' })).toBe(false);
    expect(fireEvent.keyDown(region, { key: 'F7', shiftKey: true })).toBe(false);
    await waitFor(() => expect(host.goToChange.mock.calls).toEqual([['next'], ['previous']]));
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
    expect(host.setDiffPrefs).toHaveBeenLastCalledWith({ mode: 'split', ignoreWhitespace: true, wordWrap: true });
    expect(JSON.parse(localStorage.getItem(DIFF_PREFS_STORAGE_KEY)!)).toEqual({ mode: 'split', ignoreWhitespace: true, wordWrap: true });
    fireEvent.click(button('Hunk'));
    expect(useDiffPrefs.getState().prefs.mode).toBe('hunk');
    // No placeholder UI (plan 1B global constraints).
    expect(screen.queryByRole('button', { name: /Blame|History|Edit/ })).toBeNull();
  });

  it('Previous change / Next change move through the diff; mouse-down on the toolbar never takes focus', async () => {
    renderPanel(targetFor(change('a.txt'), spec), text);
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
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

    it('a raster image shows the image diff, not a binary summary; Previous/Next and F7 stay off', async () => {
      renderPanel(targetFor(change('logo.png'), spec), async () => contents(png(90), png(100), { image: true }));
      expect(await screen.findByRole('toolbar', { name: 'Image diff options' })).toBeInTheDocument();
      await waitFor(() => expect(layers()).toEqual(['before', 'after']));
      expect(screen.getByTestId('image-size')).toHaveTextContent('90 B → 100 B');
      expect(screen.queryByTestId('binary-summary')).toBeNull();
      expect(screen.queryByTestId('text-diff')).toBeNull();
      expect(button('Previous change')).toBeDisabled();
      expect(button('Next change')).toBeDisabled();
      expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' })).toBe(true);
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

    it('an SVG shows as images, and its Source toggle shows the text diff; F7 stays off', async () => {
      renderPanel(targetFor(change('icon.svg'), spec), async () => contents(svg('<rect/>'), svg('<circle/>')));
      await waitFor(() => expect(layers()).toEqual(['before', 'after']));
      expect(screen.queryByTestId('text-diff')).toBeNull();
      expect(host.showDiff).not.toHaveBeenCalled();
      fireEvent.click(button('Source'));
      expect(await screen.findByTestId('text-diff')).toBeInTheDocument();
      await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'icon.svg', original: '<svg><rect/></svg>\n', modified: '<svg><circle/></svg>\n', language: 'xml' })));
      expect(button('Next change')).toBeDisabled();
      expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' })).toBe(true);
    });

    it('File View shows the image at that revision only; its SVG source is the file, not a diff', async () => {
      renderPanel(targetFor(change('icon.svg'), spec), async () => contents(svg('<rect/>'), svg('<circle/>')));
      await waitFor(() => expect(layers()).toHaveLength(2));
      fireEvent.click(button('File View'));
      await waitFor(() => expect(layers()).toEqual(['after']));
      expect(screen.getByTestId('image-dims')).toHaveTextContent(/^— →/);
      fireEvent.click(button('Source'));
      expect(await screen.findByTestId('file-view')).toBeInTheDocument();
      await waitFor(() => expect(host.showFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'icon.svg', text: '<svg><circle/></svg>\n' })));
      expect(host.showDiff).not.toHaveBeenCalled();
    });

    it('a binary SVG side has no bytes to show, so it keeps the binary summary', async () => {
      renderPanel(targetFor(change('odd.svg'), spec), async () => contents(svg('<rect/>'), sized({ binary: true, encoding: '', text: null, size: 12 })));
      expect(await screen.findByTestId('binary-summary')).toHaveTextContent('Binary file · 10 B → 12 B');
      expect(create).not.toHaveBeenCalled();
    });

    it('a deleted image in File View shows its last revision', async () => {
      renderPanel(fileViewTarget('gone.png', spec.id, spec), async () => contents(png(90), null, { image: true }));
      await waitFor(() => expect(layers()).toEqual(['before']));
      expect(screen.getByTestId('image-dims')).toHaveTextContent(/→ —$/);
    });
  });

  it('← in the diff zone moves the focus to the files', async () => {
    const { store } = renderPanel(targetFor(change('a.txt'), spec), text);
    act(() => store.getState().setFocus('diff'));
    const region = screen.getByRole('region', { name: 'Diff' });
    expect(fireEvent.keyDown(region, { key: 'ArrowLeft' })).toBe(false);
    expect(store.getState().focus).toBe('files');
  });
});
