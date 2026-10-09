import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { BlobSource } from '../api/gen/BlobSource';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { createRepoViewStore, RepoViewContext, targetFor, useRepoView, type DiffTarget } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { changeStepper } from './changeStepper';
import { DiffPanel } from './DiffPanel';
import { DiffTextBody } from './DiffTextBody';
import { DEFAULT_DIFF_PREFS, useDiffPrefs } from './diffPrefs';
import { PARSE_BUDGET_MS, PRECHECK_BYTES, RENDER_MAX_BYTES, useSlowMarkdown } from './markdownFiles';
import { clearMarkdownOverride, showSourceFor, useMarkdownOverride } from './markdownOverride';
import { INLINE_BREAKPOINT_PX } from './options';

const host = vi.hoisted(() => ({
  hexView: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
  attachDiff: vi.fn(), detachDiff: vi.fn(), showDiff: vi.fn(async () => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(),
  setModifiedEditable: vi.fn(), onModifiedEdit: vi.fn(), modifiedText: vi.fn((_identity?: string): string | null => null), setFileEditable: vi.fn(), onFileEdit: vi.fn(),
  fileText: vi.fn(() => null), keepViewOnNextShow: vi.fn(), keepDiff: vi.fn(() => false), keepFile: vi.fn(() => false),
  setContextMenuHandler: vi.fn(), layout: vi.fn(), releaseDetached: vi.fn(), setLineGutter: vi.fn(), onDiffSelection: vi.fn(),
  fileScrollTop: vi.fn(() => 0), setFileScrollTop: vi.fn(), fileViewState: vi.fn(() => null), restoreFileViewState: vi.fn(),
}));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
// mdOpen.test.ts covers where the open goes; here, when it happens.
const opens = vi.hoisted(() => ({ hold: vi.fn((_pane: HTMLElement) => () => {}), line: vi.fn((_pane: HTMLElement, _at: unknown) => () => {}) }));
vi.mock('./mdOpen', () => ({ holdFirstChange: opens.hold, holdLine: opens.line }));
vi.mock('../api/client', async (actual) => ({ ...(await actual<typeof import('../api/client')>()), api: { listOpeners: async () => [], openIn: async () => null } }));
vi.mock('../markdown/fileLinks', () => ({}));
// T5's renderer is tested by T5: here, what Diff View hands it.
// A new side holding GIVE_UP stands for a diff that ran out of time (R14): it calls onTooLarge.
const GIVE_UP = '<!-- give up -->';
vi.mock('../markdown/lazy', async () => {
  const { useEffect } = await import('react');
  return {
    Markdown: () => null,
    MarkdownDiff: ({ old, new: neu, context, oldContext, split, onTooLarge }: { old: string; new: string; context: { commit: string }; oldContext: { commit: string; path: string }; split?: boolean; onTooLarge?: () => void }) => {
      useEffect(() => { if (neu.includes(GIVE_UP)) onTooLarge?.(); }, [neu, onTooLarge]);
      return <div data-testid="md-diff" data-old={old} data-new={neu} data-commit={context.commit} data-old-commit={oldContext.commit} data-old-path={oldContext.path} data-split={split ? 'yes' : 'no'} />;
    },
  };
});
// The diff stream, timed by Diff View: as FileBody.test's chunkStream mock.
const parse = vi.hoisted(() => ({ cost: 0, now: 0, calls: 0 }));
vi.mock('../markdown/parseAsync', () => ({
  diffChunkStream: () => {
    parse.calls++;
    const fns = new Set<() => void>();
    const s = { chunks: [], done: false, failed: false, tooLarge: false, version: 0, subscribe: (f: () => void) => { fns.add(f); return () => { fns.delete(f); }; } };
    if (parse.cost >= 0) setTimeout(() => { parse.now += parse.cost; s.done = true; fns.forEach((f) => f()); }, 0);
    return s;
  },
}));

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const P = 'a'.repeat(40);
const C = 'c'.repeat(40);
const spec = { kind: 'commit' as const, id: C, parent: 0 };
const blob = (text: string | null): BlobPayload => ({ size: text?.length ?? 8, binary: false, encoding: 'UTF-8', eol: 'lf', text, base64: null, hash: text === null ? null : 'h1' });
const contents = (old: BlobPayload | null, neu: BlobPayload | null): DiffContentsPayload => ({ old, new: neu, tooLarge: false, eolOnly: false, image: false });
const at = (commit: string): BlobSource => ({ kind: 'atCommit', commit });
const change = (path: string, old: BlobSource, neu: BlobSource, oldPath: string | null = null) => ({ path, oldPath, status: oldPath ? 'R' : 'M', additions: 1, deletions: 1, old, new: neu, submodule: false });

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
const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS });
  Object.assign(parse, { cost: 0, now: 0, calls: 0 });
  useSlowMarkdown.setState({ slow: {} });
  clearMarkdownOverride();
});
afterEach(() => vi.restoreAllMocks());

describe('the rendered Markdown diff in Diff View (5C)', () => {
  it('is Rendered by default: the toggle in the toolbar, the text diff kept attached under it, both sides with their commits and paths', async () => {
    renderPanel(targetFor(change('docs/guide.md', at(P), at(C), 'docs/old-guide.md'), spec), async () => contents(blob('# Old\n'), blob('# New\n')));
    const md = await screen.findByTestId('md-diff');
    expect(md).toHaveAttribute('data-old', '# Old\n');
    expect(md).toHaveAttribute('data-new', '# New\n');
    expect(md).toHaveAttribute('data-commit', C);
    expect(md).toHaveAttribute('data-old-commit', P);
    expect(md).toHaveAttribute('data-old-path', 'docs/old-guide.md');
    expect(screen.getByRole('toolbar', { name: 'Diff options' })).toContainElement(toggle());
    expect(within(toggle()!).getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    expect(screen.getByTestId('text-diff')).not.toBeVisible();
    expect(host.detachDiff).not.toHaveBeenCalled();
    expect(button('Hunk')).toHaveAttribute('aria-disabled', 'true');
    for (const name of ['Inline', 'Split']) expect(button(name)).not.toHaveAttribute('aria-disabled');
    expect(changeStepper()).not.toBeNull();
    // F7 steps the rendered changes, not the hidden editor's.
    fireEvent.keyDown(screen.getByRole('region', { name: 'Diff' }), { key: 'F7' });
    await new Promise((r) => setTimeout(r, 0));
    expect(host.goToChange).not.toHaveBeenCalled();
  });

  it('Source shows the text diff and its modes; the pick is the same app-wide one File View uses (R2)', async () => {
    renderPanel(targetFor(change('README.md', at(P), at(C)), spec), async () => contents(blob('# Q\n'), blob('# R\n')));
    await screen.findByTestId('md-diff');
    pick('Source');
    expect(screen.queryByTestId('md-diff')).toBeNull();
    expect(screen.getByTestId('text-diff')).toBeVisible();
    expect(button('Split')).not.toHaveAttribute('aria-disabled');
    expect(useDiffPrefs.getState().prefs.markdownView).toBe('source');
    expect(changeStepper()).toBeNull();
    await waitFor(() => expect(host.layout).toHaveBeenCalled());
  });

  it('an added file renders against an empty old side; a deleted one against an empty new side, at the old commit (R6)', async () => {
    renderPanel(targetFor(change('new.md', { kind: 'absent' }, at(C)), spec), async () => contents(null, blob('# A\n')));
    let md = await screen.findByTestId('md-diff');
    expect(md).toHaveAttribute('data-old', '');
    expect(md).toHaveAttribute('data-old-commit', C);
    cleanup();
    renderPanel(targetFor(change('gone.md', at(P), { kind: 'absent' }), spec), async () => contents(blob('# A\n'), null));
    md = await screen.findByTestId('md-diff');
    expect(md).toHaveAttribute('data-new', '');
    expect(md).toHaveAttribute('data-commit', P);
  });

  it("a just-created file's Source holds in Diff View until the toggle is used (R2, markdownOverride)", async () => {
    showSourceFor('new.md');
    renderPanel(targetFor(change('new.md', { kind: 'absent' }, at(C)), spec), async () => contents(null, blob('# A\n')));
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    expect(within(toggle()!).getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('md-diff')).toBeNull();
    expect(button('Split')).not.toHaveAttribute('aria-disabled');
    pick('Rendered');
    expect(await screen.findByTestId('md-diff')).toBeInTheDocument();
    expect(useMarkdownOverride.getState().path).toBeNull();
  });

  it("another file's diff ends a just-created file's Source", async () => {
    showSourceFor('new.md');
    renderPanel(targetFor(change('other.md', at(P), at(C)), spec), async () => contents(blob('# Q\n'), blob('# R\n')));
    expect(await screen.findByTestId('md-diff')).toBeInTheDocument();
    // The override ends in an effect, which a loaded machine may run after the diff shows.
    await waitFor(() => expect(useMarkdownOverride.getState().path).toBeNull());
  });

  it('Inline and Split switch the rendered diff between one column and side by side; the pick persists', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    renderPanel(targetFor(change('guide.md', at(P), at(C)), spec), async () => contents(blob('# Q\n'), blob('# R\n')));
    const md = await screen.findByTestId('md-diff');
    expect(md).toHaveAttribute('data-split', 'no');
    fireEvent.click(button('Split'));
    expect(md).toHaveAttribute('data-split', 'yes');
    expect(button('Split')).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('gitbolt.diffPrefs.v1')).toContain('"mode":"split"');
    fireEvent.click(button('Inline'));
    expect(md).toHaveAttribute('data-split', 'no');
  });

  it("a panel narrower than the text diff's Split breakpoint shows Split as one column", async () => {
    useDiffPrefs.getState().set({ mode: 'split' });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(INLINE_BREAKPOINT_PX - 1);
    renderPanel(targetFor(change('guide.md', at(P), at(C)), spec), async () => contents(blob('# Q\n'), blob('# R\n')));
    const md = await screen.findByTestId('md-diff');
    await waitFor(() => expect(md).toHaveAttribute('data-split', 'no'));
    expect(button('Split')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows no toggle for a text file', async () => {
    renderPanel(targetFor(change('notes.txt', at(P), at(C)), spec), async () => contents(blob('a\n'), blob('b\n')));
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    expect(toggle()).toBeNull();
    expect(screen.queryByTestId('markdown-diff')).toBeNull();
    expect(screen.getByTestId('text-diff')).toBeVisible();
  });

  it('the working copy: Rendered shows the unsaved buffer and keeps the editor attached (R8)', async () => {
    useDiffPrefs.getState().set({ markdownView: 'source' });
    const wip = { kind: 'wip' as const, worktree: '/r', staged: false };
    const target = targetFor(change('notes.md', { kind: 'object', oid: '1'.repeat(40) }, { kind: 'worktree', worktree: '/r' }), wip);
    renderPanel(target, async () => contents(blob('# Index\n'), blob('# On disk\n')));
    await waitFor(() => expect(host.setModifiedEditable).toHaveBeenLastCalledWith(true));
    host.modifiedText.mockReturnValue('# Edited, not saved\n');
    pick('Rendered');
    const md = await screen.findByTestId('md-diff');
    expect(md).toHaveAttribute('data-new', '# Edited, not saved\n');
    expect(md).toHaveAttribute('data-commit', 'worktree');
    expect(host.modifiedText).toHaveBeenCalledWith(target.key);
    expect(host.detachDiff).not.toHaveBeenCalled();
  });

  describe('too large to render (R14)', () => {
    beforeEach(() => { vi.spyOn(performance, 'now').mockImplementation(() => parse.now); });

    it('over 5 MB a side: Source, "Too large to render", and Rendered says why', async () => {
      renderPanel(targetFor(change('huge.md', at(P), at(C)), spec), async () => contents(blob('# a\n'), blob('x'.repeat(RENDER_MAX_BYTES + 1))));
      expect(await screen.findByRole('note')).toHaveTextContent('Too large to render');
      expect(screen.queryByTestId('md-diff')).toBeNull();
      expect(screen.getByTestId('text-diff')).toBeVisible();
      expect(within(toggle()!).getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-disabled', 'true');
      expect(button('Split')).not.toHaveAttribute('aria-disabled');
      expect(parse.calls).toBe(0);
    });

    it('a diff that gives up, at any size, falls back to Source with the note, and stays there', async () => {
      const t = targetFor(change('small.md', at(P), at(C)), spec);
      renderPanel(t, async () => contents(blob('# Small\n'), blob(`# Small\n\n${GIVE_UP}\n`)));
      expect(await screen.findByRole('note')).toHaveTextContent('Too large to render');
      expect(screen.queryByTestId('md-diff')).toBeNull();
      expect(screen.getByTestId('text-diff')).toBeVisible();
      expect(within(toggle()!).getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-disabled', 'true');
      expect(button('Split')).not.toHaveAttribute('aria-disabled');
      expect(Object.keys(useSlowMarkdown.getState().slow)).toHaveLength(1);
      cleanup();
      renderPanel(t, async () => contents(blob('# Small\n'), blob(`# Small\n\n${GIVE_UP}\n`)));
      expect(await screen.findByRole('note')).toHaveTextContent('Too large to render');
    });

    it('a diff that takes over 2 s falls back to Source and stays there', async () => {
      parse.cost = PARSE_BUDGET_MS + 500;
      const long = `# Long\n${'y'.repeat(PRECHECK_BYTES)}`;
      const t = targetFor(change('long.md', at(P), at(C)), spec);
      renderPanel(t, async () => contents(blob('# Long\n'), blob(long)));
      expect(await screen.findByText('Rendering…')).toBeInTheDocument();
      expect(await screen.findByRole('note')).toHaveTextContent('Too large to render');
      expect(screen.queryByTestId('md-diff')).toBeNull();
      cleanup();
      renderPanel(t, async () => contents(blob('# Long\n'), blob(long)));
      expect(await screen.findByRole('note')).toHaveTextContent('Too large to render');
      expect(parse.calls).toBe(1);
    });
  });
});

describe('DiffTextBody', () => {
  it("another file's rendered diff starts at the top; the same file keeps its place", async () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const props = { path: 'a.md', oldPath: null, original: 'a\n', modified: 'b\n', language: 'markdown', markdown: { old: P, new: C } };
    const { rerender } = render(<RepoViewContext value={store}><DiffTextBody identity="a" {...props} /></RepoViewContext>);
    await screen.findByTestId('md-diff');
    const pane = screen.getByTestId('markdown-diff');
    let top = 0;
    Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
    pane.scrollTop = 500;
    rerender(<RepoViewContext value={store}><DiffTextBody identity="a" {...props} modified={'b, edited\n'} /></RepoViewContext>);
    expect(pane.scrollTop).toBe(500);
    rerender(<RepoViewContext value={store}><DiffTextBody identity="b" {...props} path="b.md" /></RepoViewContext>);
    expect(screen.getByTestId('markdown-diff')).toBe(pane);
    expect(pane.scrollTop).toBe(0);
  });

  it('a rendered diff opens at its first change: once per file shown or switch to Rendered, not when a line is asked for', async () => {
    opens.hold.mockClear();
    opens.line.mockClear();
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const props = { path: 'a.md', oldPath: null, original: 'a\n', modified: 'b\n', language: 'markdown', markdown: { old: P, new: C } };
    const { rerender } = render(<RepoViewContext value={store}><DiffTextBody identity="a" {...props} /></RepoViewContext>);
    await screen.findByTestId('md-diff');
    expect(opens.hold).toHaveBeenCalledTimes(1);
    expect(opens.hold).toHaveBeenLastCalledWith(screen.getByTestId('markdown-diff'));
    rerender(<RepoViewContext value={store}><DiffTextBody identity="a" {...props} modified={'b, edited\n'} /></RepoViewContext>);
    expect(opens.hold).toHaveBeenCalledTimes(1);
    rerender(<RepoViewContext value={store}><DiffTextBody identity="b" {...props} path="b.md" /></RepoViewContext>);
    expect(opens.hold).toHaveBeenCalledTimes(2);
    act(() => useDiffPrefs.getState().set({ markdownView: 'source' }));
    act(() => useDiffPrefs.getState().set({ markdownView: 'rendered' }));
    expect(opens.hold).toHaveBeenCalledTimes(3);
    rerender(<RepoViewContext value={store}><DiffTextBody identity="c" {...props} path="c.md" line={{ side: 'modified', line: 12 }} /></RepoViewContext>);
    expect(opens.hold).toHaveBeenCalledTimes(3);
    // A note's line opens the rendered diff at its block; the same file at another line goes there too.
    expect(opens.line).toHaveBeenLastCalledWith(screen.getByTestId('markdown-diff'), { side: 'modified', line: 12 });
    rerender(<RepoViewContext value={store}><DiffTextBody identity="c" {...props} path="c.md" line={{ side: 'modified', line: 30 }} /></RepoViewContext>);
    expect(opens.line).toHaveBeenCalledTimes(2);
    expect(opens.hold).toHaveBeenCalledTimes(3);
  });

  it("Rendered hides what follows the editor (a WIP diff's hunk actions); Source shows it again", async () => {
    const props = { identity: 'k', path: 'a.md', oldPath: null, original: 'a\n', modified: 'b\n', language: 'markdown', after: <span data-testid="after" />, markdown: { old: P, new: C } };
    render(<RepoViewContext value={createRepoViewStore(1, '/r', graph, fakeServices())}><DiffTextBody {...props} /></RepoViewContext>);
    expect(await screen.findByTestId('md-diff')).toBeInTheDocument();
    expect(screen.queryByTestId('after')).toBeNull();
    act(() => useDiffPrefs.getState().set({ markdownView: 'source' }));
    expect(screen.getByTestId('after')).toBeInTheDocument();
  });
});
