import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPLIT } from './detailsSplit';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { createCommitMessageCache } from '../api/commitMessages';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { createServices } from '../repo/services';
import { createRepoViewStore, RepoViewContext, type RepoViewStore } from '../repo/store';
import { fakeServices, recordingServices } from '../repo/testServices';
import { DetailsPanel } from './DetailsPanel';

const api = vi.hoisted(() => ({
  commitDetails: vi.fn(),
  commitMessage: vi.fn(),
  fileList: vi.fn(),
  diffContents: vi.fn(),
  signature: vi.fn(),
  treeFiles: vi.fn(),
  remotes: vi.fn(),
  openUrl: vi.fn(),
}));
vi.mock('../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../api/client')>(), api }));

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const never = () => new Promise<never>(() => {});
const commit = (id: string, summary: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: 'grace@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const wipRow: RowPayload = { ...commit('wip:/r', ''), kind: 'wip', wip: { worktreePath: '/r', worktreeName: null, modified: 1, added: 1, deleted: 0, renamed: 0, conflicted: 0 } };
const graph: GraphPayload = { rows: [wipRow, commit(A, 'Second'), commit(B, 'First')], labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false, worktrees: [] };
const file = (path: string): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object', oid: B }, new: { kind: 'worktree', worktree: '/r' }, submodule: false });
const list = (...paths: string[]): FileListPayload => ({ files: paths.map(file), added: paths.length, deleted: 0 });

/** Services whose loads all resolve: details, messages and one-file lists per commit. */
function loadedServices() {
  const rec = { summary: { [A]: 'Second', [B]: 'First' } as Record<string, string> };
  return fakeServices({
    details: new Loader(async (id) => ({ id, parents: [], signed: false, coAuthors: [], author: { name: 'Grace Hopper', email: 'grace@example.com', time: 0 }, committer: { name: 'Grace Hopper', email: 'grace@example.com', time: 0 } }), new Lru(8)),
    messages: createCommitMessageCache(async (id) => ({ id, summary: rec.summary[id] ?? '', body: '' })),
    files: new Loader(async () => list('a.txt'), new Lru(8)),
  });
}

function renderPanel(store: RepoViewStore) {
  render(<RepoViewContext value={store}><DetailsPanel /></RepoViewContext>);
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.commitDetails.mockImplementation(never);
  api.commitMessage.mockImplementation(never);
  api.fileList.mockImplementation(never);
  api.remotes.mockResolvedValue([]);
});

describe('DetailsPanel', () => {
  it('the Edit message pencil shows for the HEAD commit only, and not mid merge or rebase (spec #2 §8.3)', async () => {
    const store = createRepoViewStore(1, '/r', graph, loadedServices());
    renderPanel(store);
    await act(async () => store.getState().selectRow(1));
    expect(await screen.findByRole('button', { name: 'Edit message' })).toBeTruthy();
    await act(async () => store.getState().selectRow(2));
    expect(await screen.findByText('First')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    store.setState((s) => ({ graph: { ...s.graph, inProgress: { '/r': { kind: 'other', what: 'revert' } } } }));
    await act(async () => store.getState().selectRow(1));
    expect(await screen.findByText('Second')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
  });

  it('the pencil shows on an older commit of HEAD\'s branch too, not on its first commit nor mid rebase (spec #3 §3.6)', async () => {
    const C = 'c'.repeat(40);
    const chain: GraphPayload = { ...graph, rows: [wipRow, { ...commit(A, 'Second'), parents: [B] }, { ...commit(B, 'First'), parents: [C] }, commit(C, 'Root')] };
    const store = createRepoViewStore(1, '/r', chain, loadedServices());
    renderPanel(store);
    await act(async () => store.getState().selectRow(2));
    expect(await screen.findByRole('button', { name: 'Edit message' })).toBeTruthy();
    await act(async () => store.getState().selectRow(3));
    await waitFor(() => expect(screen.queryByText('First')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    store.setState((s) => ({ graph: { ...s.graph, inProgress: { '/r': { kind: 'other', what: 'revert' } } } }));
    await act(async () => store.getState().selectRow(2));
    expect(await screen.findByText('First')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
  });

  it('no pencil on a merge, a commit not under HEAD, or a trunk commit below the fork (3C T13 fix 1 I1, M7)', async () => {
    const [X, S, N, M, R] = ['1', '2', '3', '4', '5'].map((c) => c.repeat(40));
    // feature (HEAD): A ← X (merge of S) ← M (main's tip) ← R; S on feature; N on another branch.
    const rows = [wipRow, { ...commit(A, 'Tip'), parents: [X] }, { ...commit(N, 'Elsewhere'), parents: [M] }, { ...commit(X, 'Merge'), parents: [M, S] }, { ...commit(S, 'Side'), parents: [M] }, { ...commit(M, 'Trunk'), parents: [R] }, commit(R, 'Root')];
    const label = (row: number, local: string) => ({ row, name: local.slice(11), local, remotes: [], tag: false, isHead: false, worktree: null, checkedOut: null });
    const g: GraphPayload = { ...graph, rows, labels: [label(1, 'refs/heads/feature'), label(5, 'refs/heads/main')], head: { branch: 'refs/heads/feature', target: A, detached: false, unborn: false } };
    const summaries = Object.fromEntries(rows.map((r) => [r.id, r.summary]));
    const services = fakeServices({
      details: new Loader(async (id) => ({ id, parents: [], signed: false, coAuthors: [], author: { name: 'G', email: 'g@example.com', time: 0 }, committer: { name: 'G', email: 'g@example.com', time: 0 } }), new Lru(8)),
      messages: createCommitMessageCache(async (id) => ({ id, summary: summaries[id] ?? '', body: '' })),
      files: new Loader(async () => list('a.txt'), new Lru(8)),
    });
    const store = createRepoViewStore(1, '/r', g, services);
    renderPanel(store);
    const pencilAt = async (index: number, summary: string) => {
      await act(async () => store.getState().selectRow(index));
      await screen.findByText(summary);
      return screen.queryByRole('button', { name: 'Edit message' });
    };
    expect(await pencilAt(4, 'Side')).toBeTruthy();
    expect(await pencilAt(3, 'Merge')).toBeNull();
    expect(await pencilAt(2, 'Elsewhere')).toBeNull();
    expect(await pencilAt(5, 'Trunk')).toBeNull();
  });

  it('a Ctrl+click on a second commit shows the compare header at once, no hint step (K15); a plain click leaves it', async () => {
    const store = createRepoViewStore(1, '/r', graph, loadedServices());
    renderPanel(store);
    await act(async () => store.getState().selectRow(2));
    expect(screen.getByTestId('details-summary')).toHaveTextContent('First');
    await act(async () => store.getState().selectRow(1, { ctrl: true }));
    expect(screen.getByTestId('compare-header')).toHaveTextContent(`Comparing ${B.slice(0, 6)} → ${A.slice(0, 6)}`);
    // The compare replaces the single-commit details, and lists the compare's files.
    expect(screen.queryByTestId('details-summary')).toBeNull();
    expect(screen.getAllByTestId('compare-summary').map((e) => e.textContent)).toEqual(['First', 'Second']);
    expect(store.getState().sections.map((s) => s.spec)).toEqual([{ kind: 'compare', from: B, to: A }]);
    await act(async () => store.getState().selectRow(2));
    expect(screen.queryByTestId('compare-header')).toBeNull();
    expect(screen.getByTestId('details-summary')).toHaveTextContent('First');
  });

  // Feedback F12: no flicker. The old commit's content stays until the new commit's details,
  // message and file list have all arrived; then the new one replaces it in one render.
  it('switching commits keeps the old content, whole, until all three loads resolve, then swaps in one render', async () => {
    const rec = recordingServices();
    const store = createRepoViewStore(1, '/r', graph, rec.services);
    renderPanel(store);
    const detailsOf = (id: string, name: string) => ({ id, parents: [], signed: false, coAuthors: [], author: { name, email: `${name}@example.com`, time: 0 }, committer: { name, email: `${name}@example.com`, time: 0 } });
    const filesOf = (id: string) => `files {"kind":"commit","id":"${id}","parent":0}`;
    act(() => store.getState().selectRow(1));
    // Nothing yet to show: no empty or skeleton frame either.
    expect(screen.queryByTestId('details-summary')).toBeNull();
    expect(screen.queryByText('Loading files…')).toBeNull();
    await act(async () => {
      rec.resolve(`details ${A}`, detailsOf(A, 'Ada'));
      rec.resolve(`message ${A}`, { id: A, summary: 'Second', body: 'Body of second' });
      rec.resolve(filesOf(A), list('second.txt'));
    });
    const content = () => ({
      sha: screen.queryByTestId('details-sha')?.textContent,
      author: screen.queryByTestId('author')?.textContent,
      summary: screen.queryByTestId('details-summary')?.textContent,
      body: screen.queryByTestId('details-body')?.textContent ?? null,
      files: screen.queryAllByRole('option').map((o) => o.dataset.path),
    });
    const second = { sha: A.slice(0, 6), author: expect.stringContaining('Ada'), summary: 'Second', body: 'Body of second', files: ['second.txt'] };
    expect(content()).toEqual(second);

    // Record every DOM state the panel goes through from here on.
    const seen: ReturnType<typeof content>[] = [];
    const observer = new MutationObserver(() => seen.push(content()));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    act(() => store.getState().selectRow(2));
    expect(content()).toEqual(second);
    await act(async () => rec.resolve(`details ${B}`, detailsOf(B, 'Bob')));
    expect(content()).toEqual(second);
    await act(async () => rec.resolve(filesOf(B), list('first.txt')));
    expect(content()).toEqual(second);
    await act(async () => rec.resolve(`message ${B}`, { id: B, summary: 'First', body: '' }));
    const first = { sha: B.slice(0, 6), author: expect.stringContaining('Bob'), summary: 'First', body: null, files: ['first.txt'] };
    expect(content()).toEqual(first);
    await act(async () => {});
    observer.disconnect();
    // Every recorded state is one commit's full content: never a mix, never empty.
    expect(seen.length).toBeGreaterThan(0);
    for (const state of seen) expect([second, first]).toContainEqual(state);
  });

  it('the WIP row shows its header and its Unstaged and Staged lists, re-read on every selection (deviation 9)', async () => {
    let reads = 0;
    api.fileList.mockImplementation(async (_repo: number, spec: DiffSpec) => {
      if (spec.kind !== 'wip') return never();
      reads++;
      // The worktree changed between the two selections: the second read sees a new file.
      if (spec.staged) return list('src/app.php');
      return reads <= 2 ? list('notes.txt') : list('notes.txt', 'todo.txt');
    });
    const store = createRepoViewStore(1, '/r', graph, createServices(1));
    renderPanel(store);
    act(() => store.getState().selectRow(0));
    expect(await screen.findByTestId('wip-header')).toHaveTextContent('2 file changes on main');
    expect(await screen.findByRole('heading', { name: 'Unstaged (1)' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Staged (1)' })).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Unstaged' })).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Staged' })).toBeInTheDocument();
    expect(screen.queryByTestId('details-summary')).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard all' })).toBeInTheDocument();
    expect(api.fileList.mock.calls.map(([, spec]) => spec)).toEqual([
      { kind: 'wip', worktree: '/r', staged: false },
      { kind: 'wip', worktree: '/r', staged: true },
    ]);

    act(() => store.getState().selectRow(1));
    act(() => store.getState().selectRow(0));
    expect(await screen.findByRole('heading', { name: 'Unstaged (2)' })).toBeInTheDocument();
    expect(api.fileList.mock.calls.filter(([, spec]) => (spec as DiffSpec).kind === 'wip')).toHaveLength(4);
  });

  // Feedback F13: the header is fixed, only the message scrolls, and a draggable split sits
  // between the header+message and the file list (25 / 75 by default, persisted).
  describe('split', () => {
    let height: PropertyDescriptor | undefined;
    beforeEach(() => {
      height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
      // jsdom lays nothing out: give the panel 1000 px and the header 100 px.
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('details-panel') ? 1000 : 0; } });
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('commit-header') ? 100 : 0; });
    });
    afterEach(() => {
      if (height) Object.defineProperty(HTMLElement.prototype, 'clientHeight', height);
      vi.restoreAllMocks();
      localStorage.clear();
    });

    /** Waits a frame: the split's drag writes the live flexBasis in a `requestAnimationFrame`,
     * coalescing however many `pointermove` events land within it (K26). */
    const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

    async function shown() {
      const store = createRepoViewStore(1, '/r', graph, loadedServices());
      const view = render(<RepoViewContext value={store}><DetailsPanel /></RepoViewContext>);
      await act(async () => store.getState().selectRow(1));
      return { store, view };
    }

    it('the header sits outside the message\'s scroller, and the split starts at 25 %', async () => {
      await shown();
      const top = document.querySelector<HTMLElement>('.commit-details')!;
      const message = screen.getByTestId('commit-message');
      const header = top.querySelector('header.commit-header')!;
      expect(top.contains(message) && top.contains(header)).toBe(true);
      expect(message.contains(header)).toBe(false);
      expect(within(message).getByTestId('details-summary')).toHaveTextContent('Second');
      expect(top).toHaveStyle({ flexBasis: '25%' });
      const sep = screen.getByRole('separator', { name: 'Resize commit details' });
      expect(sep).toHaveAttribute('aria-orientation', 'horizontal');
      expect(sep).toHaveAttribute('aria-valuenow', '25');
      // Between the top section and the file lists.
      expect(top.nextElementSibling).toBe(sep);
      expect(sep.nextElementSibling).toHaveClass('file-sections');
    });

    it('drags with pointer capture, clamped to the header above and the file list below', async () => {
      await shown();
      const top = document.querySelector<HTMLElement>('.commit-details')!;
      const sep = screen.getByRole('separator', { name: 'Resize commit details' });
      expect(fireEvent.pointerDown(sep, { clientY: 250, pointerId: 1, button: 0 })).toBe(false); // no text selection
      fireEvent.pointerMove(sep, { clientY: 400, pointerId: 1 });
      await nextFrame();
      expect(top).toHaveStyle({ flexBasis: '40%' });
      fireEvent.pointerMove(sep, { clientY: 0, pointerId: 1 });
      await nextFrame();
      // At least the 100 px header plus the message minimum.
      expect(top).toHaveStyle({ flexBasis: `${((100 + SPLIT.topExtraPx) / 1000) * 100}%` });
      fireEvent.pointerMove(sep, { clientY: 2000, pointerId: 1 });
      fireEvent.pointerUp(sep, { clientY: 2000, pointerId: 1 }); // ends before the queued frame fires
      expect(sep).toHaveAttribute('aria-valuenow', String(Math.round(Math.min(SPLIT.max, 1 - SPLIT.bottomPx / 1000) * 100)));
      fireEvent.pointerMove(sep, { clientY: 300, pointerId: 1 });
      expect(sep).toHaveAttribute('aria-valuenow', String(Math.round(Math.min(SPLIT.max, 1 - SPLIT.bottomPx / 1000) * 100))); // the drag ended
      expect(Number(localStorage.getItem(SPLIT.key))).toBeCloseTo(Math.min(SPLIT.max, 1 - SPLIT.bottomPx / 1000));
    });

    it('arrow keys, Home and End move it; the ratio persists across panels', async () => {
      const { view } = await shown();
      const sep = screen.getByRole('separator', { name: 'Resize commit details' });
      fireEvent.keyDown(sep, { key: 'ArrowDown' });
      expect(sep).toHaveAttribute('aria-valuenow', '27');
      fireEvent.keyDown(sep, { key: 'ArrowUp' });
      fireEvent.keyDown(sep, { key: 'ArrowUp' });
      expect(sep).toHaveAttribute('aria-valuenow', '23');
      fireEvent.keyDown(sep, { key: 'Home' });
      expect(sep).toHaveAttribute('aria-valuenow', String(Math.round(((100 + SPLIT.topExtraPx) / 1000) * 100)));
      fireEvent.keyDown(sep, { key: 'End' });
      const end = String(Math.round(Math.min(SPLIT.max, 1 - SPLIT.bottomPx / 1000) * 100));
      expect(sep).toHaveAttribute('aria-valuenow', end);
      view.unmount();
      await shown();
      expect(screen.getByRole('separator', { name: 'Resize commit details' })).toHaveAttribute('aria-valuenow', end);
    });

    it('renders the saved ratio clamped to the measured bounds, re-clamped on resize, and keeps the choice (review fix)', async () => {
      // A ResizeObserver whose callbacks, for the ones watching the panel, the test fires.
      const observers: (() => void)[] = [];
      const Real = globalThis.ResizeObserver;
      globalThis.ResizeObserver = class {
        cb: () => void;
        constructor(cb: () => void) { this.cb = cb; }
        observe(el: Element) { if (el.classList.contains('details-panel')) observers.push(this.cb); }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      let panelPx = 1000;
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('details-panel') ? panelPx : 0; } });
      try {
        localStorage.setItem(SPLIT.key, '0.1');
        await shown();
        const top = document.querySelector<HTMLElement>('.commit-details')!;
        const sep = screen.getByRole('separator', { name: 'Resize commit details' });
        // 0.1 of 1000 px can't hold the 100 px header: the header plus the message minimum.
        const lo = (100 + SPLIT.topExtraPx) / 1000;
        expect(top).toHaveStyle({ flexBasis: `${lo * 100}%` });
        expect(sep).toHaveAttribute('aria-valuemin', String(Math.round(lo * 100)));
        expect(sep).toHaveAttribute('aria-valuemax', String(Math.round(SPLIT.max * 100)));
        // The window shrinks: 400 px keeps 160 px of files, so at most 60 % on top, at least 39 %.
        panelPx = 400;
        act(() => observers.forEach((cb) => cb()));
        expect(top).toHaveStyle({ flexBasis: `${((100 + SPLIT.topExtraPx) / 400) * 100}%` });
        expect(sep).toHaveAttribute('aria-valuemax', '60');
        // Room again: back to the (clamped) choice; the saved ratio was never overwritten.
        panelPx = 1000;
        act(() => observers.forEach((cb) => cb()));
        expect(top).toHaveStyle({ flexBasis: `${lo * 100}%` });
        expect(localStorage.getItem(SPLIT.key)).toBe('0.1');
      } finally {
        globalThis.ResizeObserver = Real;
      }
    });

    it('saves once on pointer up (not per move), and ignores other pointers', async () => {
      await shown();
      const top = document.querySelector<HTMLElement>('.commit-details')!;
      const save = vi.spyOn(Storage.prototype, 'setItem');
      const sep = screen.getByRole('separator', { name: 'Resize commit details' });
      fireEvent.pointerDown(sep, { clientY: 250, pointerId: 1, button: 0 });
      fireEvent.pointerMove(sep, { clientY: 300, pointerId: 1 });
      fireEvent.pointerMove(sep, { clientY: 350, pointerId: 1 });
      fireEvent.pointerMove(sep, { clientY: 900, pointerId: 2 }); // another pointer: ignored
      await nextFrame();
      expect(top).toHaveStyle({ flexBasis: '35%' });
      expect(save).not.toHaveBeenCalled();
      fireEvent.pointerUp(sep, { clientY: 350, pointerId: 2 }); // not ours: the drag goes on
      fireEvent.pointerMove(sep, { clientY: 400, pointerId: 1 });
      fireEvent.pointerUp(sep, { clientY: 400, pointerId: 1 });
      expect(save.mock.calls).toEqual([[SPLIT.key, '0.4']]);
    });

    it('compare and WIP have no message, so no split', async () => {
      const { store } = await shown();
      await act(async () => store.getState().selectRow(0));
      expect(screen.getByTestId('wip-header')).toBeInTheDocument();
      expect(screen.queryByRole('separator', { name: 'Resize commit details' })).toBeNull();
    });
  });
});

