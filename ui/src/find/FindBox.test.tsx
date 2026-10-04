import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import type { TabState } from '../api/gen/TabState';

const host = vi.hoisted(() => ({ openFind: vi.fn(), setContextMenuHandler: vi.fn() }));
vi.mock('../api/client', () => ({
  api: {
    findText: vi.fn(async (_r: number, q: string) => (q === 'm' ? ['a', 'c'] : [])),
    findPaths: vi.fn(async () => []),
    locateCommit: vi.fn(async () => ({ found: false, limit: null })),
    searchHistory: vi.fn(async () => []),
  },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));
vi.mock('../diff/monaco/load', () => ({ loadMonacoHost: async () => host }));
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { RepoView } = await import('../repo/RepoView');
const { createRepoViewStore } = await import('../repo/store');
const { fakeServices, idle, idleMessages } = await import('../repo/testServices');
const { activeTabWith } = await import('../app/testShell');
const { installShortcuts } = await import('../app/shortcuts');
const { runAction } = await import('../app/actions');
await import('./actions');
const { FindBox } = await import('./FindBox');
const { closeFind, useFind } = await import('./findStore');

const row = (id: string, summary: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graph: GraphPayload = { rows: [row('a', 'match one'), row('b', 'other'), row('c', 'match two')], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [] };
const tab: TabState = { id: 't', kind: 'repo', path: '/t', alias: null };

let offKeys: () => void;
function setup() {
  const services = fakeServices({ details: idle(), files: idle(), messages: idleMessages() });
  const store = activeTabWith(createRepoViewStore(1, '/t', graph, services));
  render(<RepoView repo={1} repoPath="/t" graph={graph} store={store} graphOverlay={<FindBox tab={tab} />} />);
  return store;
}
const input = () => screen.getByRole('textbox', { name: 'Find commits' });
const typeQuery = async (q: string) => {
  fireEvent.change(input(), { target: { value: q } });
  await act(() => new Promise((r) => setTimeout(r, 80)));
};
const selectedId = (store: ReturnType<typeof setup>) => {
  const s = store.getState().selection;
  return s.kind === 'commit' ? s.id : null;
};

beforeEach(() => {
  offKeys = installShortcuts();
  host.openFind.mockClear();
});
afterEach(() => {
  offKeys();
  act(() => closeFind('t'));
});

describe('FindBox', () => {
  it('Ctrl+F opens it in the graph panel, focused; typing dims the non-matches and selects the first match', async () => {
    const store = setup();
    expect(screen.queryByRole('search')).toBeNull();
    act(() => void fireEvent.keyDown(document.body, { key: 'f', code: 'KeyF', ctrlKey: true }));
    const box = screen.getByRole('search', { name: 'Find in graph' });
    expect(box.closest('.center-panel')).not.toBeNull();
    expect(document.activeElement).toBe(input());
    await typeQuery('m');
    expect(box).toHaveTextContent('1 / 2');
    expect(selectedId(store)).toBe('a');
    const dimmed = screen.getAllByRole('row').map((r) => r.querySelector('[data-col="message"]')!.classList.contains('row-dim-filter'));
    expect(dimmed).toEqual([false, true, false]);
  });

  it('Enter / Shift+Enter / ↓ / ↑ in the input step through the matches; Esc closes, clears the dimming and returns to the graph', async () => {
    const store = setup();
    act(() => void runAction('edit.find'));
    await typeQuery('m');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(selectedId(store)).toBe('c');
    expect(screen.getByRole('search')).toHaveTextContent('2 / 2');
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(selectedId(store)).toBe('a');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(selectedId(store)).toBe('c');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(selectedId(store)).toBe('a');
    act(() => void fireEvent.keyDown(input(), { key: 'Escape' }));
    expect(screen.queryByRole('search')).toBeNull();
    expect(store.getState().filterKeep).toBeNull();
    expect(useFind.getState().byTab.t.query).toBe('');
    expect(store.getState().focus).toBe('graph');
    // The selection stays on the last match.
    expect(selectedId(store)).toBe('a');
  });

  it("Esc in the box closes only the box, never the compare mode the app's Esc would leave", async () => {
    const store = setup();
    store.getState().selectRow(0);
    store.getState().selectRow(2, { ctrl: true });
    expect(store.getState().selection.kind).toBe('compare');
    act(() => void runAction('edit.find'));
    act(() => void fireEvent.keyDown(input(), { key: 'Escape' }));
    expect(screen.queryByRole('search')).toBeNull();
    expect(store.getState().selection.kind).toBe('compare');
  });

  it('Ctrl+F on an open box refocuses its input', async () => {
    setup();
    act(() => void runAction('edit.find'));
    await typeQuery('m');
    act(() => screen.getByRole('button', { name: 'Next match' }).focus());
    act(() => void fireEvent.keyDown(document.body, { key: 'f', code: 'KeyF', ctrlKey: true }));
    expect(document.activeElement).toBe(input());
  });

  it("R7: with a file open, Ctrl+F goes to Monaco's find, not the graph's", async () => {
    const store = setup();
    act(() => store.getState().openFile({ key: 'k', path: 'a.txt', oldPath: null, status: 'M', old: { kind: 'absent' }, new: { kind: 'absent' }, view: 'diff' }));
    act(() => void fireEvent.keyDown(document.body, { key: 'f', code: 'KeyF', ctrlKey: true }));
    await vi.waitFor(() => expect(host.openFind).toHaveBeenCalledTimes(1));
    expect(useFind.getState().byTab.t?.open ?? false).toBe(false);
  });
});
