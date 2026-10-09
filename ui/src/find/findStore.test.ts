import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';

const calls = vi.hoisted(() => ({ text: [] as string[], paths: [] as string[], locate: [] as string[], pathsDelay: 0 }));
vi.mock('../api/client', () => ({
  api: {
    findText: vi.fn(async (_r: number, q: string) => {
      calls.text.push(q);
      return q === 'x' ? ['c', 'a'] : q === 'xy' ? ['c'] : [];
    }),
    findPaths: vi.fn(async (_r: number, q: string) => {
      calls.paths.push(q);
      await new Promise((r) => setTimeout(r, calls.pathsDelay));
      return q === 'xy' ? ['b', 'c'] : [];
    }),
    locateCommit: vi.fn(async (_r: number, sha: string) => {
      calls.locate.push(sha);
      return sha === 'd'.repeat(40) ? { found: true, limit: 5000 } : { found: false, limit: null };
    }),
    searchHistory: vi.fn(async () => [{ id: 'e'.repeat(40), time: 0, author: 'A', summary: 'old' }]),
  },
  errorMessage: (e: unknown) => String(e),
}));

const { createRepoViewStore } = await import('../repo/store');
const { fakeServices, idle, idleMessages } = await import('../repo/testServices');
const { useTabViews, tabStore } = await import('../app/tabStores');
const { useRuntime } = await import('../app/runtime');
const { closeFind, openFind, rerunFind, revealOlder, searchOlder, setFindQuery, stepFind, useFind } = await import('./findStore');

const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graphOf = (ids: string[]): GraphPayload => ({ rows: ids.map(row), labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [] });

const state = () => useFind.getState().byTab.t;
const store = () => tabStore('t')!.getState();
const selected = () => {
  const s = store().selection;
  return s.kind === 'commit' ? s.id : null;
};

beforeEach(() => {
  calls.text.length = 0;
  calls.paths.length = 0;
  calls.locate.length = 0;
  calls.pathsDelay = 0;
  const services = fakeServices({ details: idle(), files: idle(), messages: idleMessages() });
  useTabViews.setState({ views: { t: { repo: 1, services, store: createRepoViewStore(1, '/r', graphOf(['a', 'b', 'c']), services) } } });
  closeFind('t');
});

describe('find store', () => {
  it('orders matches by row, selects the first, and wraps with next/prev', async () => {
    openFind('t');
    await setFindQuery('t', 'x', 0);
    expect(state().matches).toEqual(['a', 'c']);
    expect(state().index).toBe(0);
    expect(selected()).toBe('a');
    stepFind('t', 1);
    expect(selected()).toBe('c');
    stepFind('t', 1);
    expect(selected()).toBe('a');
    stepFind('t', -1);
    expect(selected()).toBe('c');
    expect(state().index).toBe(1);
  });

  it("dims the non-matches through the tab store's filterKeep while a query is set; closing clears it", async () => {
    openFind('t');
    expect(store().filterKeep).toBeNull();
    await setFindQuery('t', 'x', 0);
    expect([...store().filterKeep!]).toEqual(['a', 'c']);
    await setFindQuery('t', 'nothing', 0);
    expect([...store().filterKeep!]).toEqual([]);
    await setFindQuery('t', '  ', 0);
    expect(store().filterKeep).toBeNull();
    await setFindQuery('t', 'x', 0);
    closeFind('t');
    expect(state()).toMatchObject({ open: false, query: '', matches: [] });
    expect(store().filterKeep).toBeNull();
  });

  it('path search: only from 2 characters; path matches merge in after the text ones, keeping the current match', async () => {
    openFind('t');
    await setFindQuery('t', 'x', 0);
    expect(calls.paths).toEqual([]);
    await setFindQuery('t', 'xy', 0);
    expect(calls.paths).toEqual(['xy']);
    expect(state().matches).toEqual(['b', 'c']);
    expect(state().pathPending).toBe(false);
    // 'c' (the text match, selected first) stays the current match when 'b' merges in above it.
    expect(selected()).toBe('c');
    expect(state().index).toBe(1);
  });

  it('shows text matches while the path search is pending, then merges', async () => {
    openFind('t');
    calls.pathsDelay = 200;
    const done = setFindQuery('t', 'xy', 0);
    await vi.waitFor(() => expect(state().pathPending).toBe(true), { interval: 5 });
    expect(state().matches).toEqual(['c']);
    await done;
    expect(state().matches).toEqual(['b', 'c']);
    expect(state().pathPending).toBe(false);
  });

  it('ignores stale responses: a newer query wins', async () => {
    openFind('t');
    calls.pathsDelay = 20;
    const first = setFindQuery('t', 'xy', 0);
    await vi.waitFor(() => expect(calls.paths).toEqual(['xy']));
    await setFindQuery('t', 'zz', 0);
    await first;
    expect(state().matches).toEqual([]);
    expect(state().pathPending).toBe(false);
  });

  it('debounces: only the last query of a burst is searched', async () => {
    vi.useFakeTimers();
    try {
      openFind('t');
      void setFindQuery('t', 'x');
      void setFindQuery('t', 'xy');
      const last = setFindQuery('t', 'x');
      await vi.advanceTimersByTimeAsync(49);
      expect(calls.text).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await last;
      expect(calls.text).toEqual(['x']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a full hash outside the window loads a deep enough window, then selects it', async () => {
    const sha = 'd'.repeat(40);
    const refresh = vi.fn(async () => {
      expect(useRuntime.getState().tabs.t?.limit).toBe(5000);
      store().setGraph(graphOf(['a', 'b', 'c', sha]));
      // As FindBox does on every new graph: skipped, since the typed query is still running.
      await rerunFind('t');
    });
    const realRefresh = useRuntime.getState().refresh;
    useRuntime.setState({ refresh });
    const { api } = await import('../api/client');
    const realText = vi.mocked(api.findText).getMockImplementation()!;
    try {
      vi.mocked(api.findText).mockImplementation(async (_r, q) => (refresh.mock.calls.length && q === sha ? [sha] : []));
      openFind('t');
      await setFindQuery('t', sha, 0);
      expect(calls.locate).toEqual([sha]);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(state().matches).toEqual([sha]);
      expect(selected()).toBe(sha);
      // Not found within the locate limit: a message, no refresh.
      await setFindQuery('t', 'f'.repeat(40), 0);
      expect(state().message).toBe('Not in the loaded history');
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      useRuntime.setState({ refresh: realRefresh });
      vi.mocked(api.findText).mockImplementation(realText);
    }
  });

  it('a full hash outside the window that a loaded revert message mentions: still located, merged in and selected', async () => {
    const sha = 'd'.repeat(40);
    // 'b' is "Revert <sha>": a message match, in the window from the start.
    const refresh = vi.fn(async () => store().setGraph(graphOf(['a', 'b', 'c', sha])));
    const realRefresh = useRuntime.getState().refresh;
    useRuntime.setState({ refresh });
    const { api } = await import('../api/client');
    const realText = vi.mocked(api.findText).getMockImplementation()!;
    try {
      vi.mocked(api.findText).mockImplementation(async (_r, q) => (q !== sha ? [] : refresh.mock.calls.length ? ['b', sha] : ['b']));
      openFind('t');
      await setFindQuery('t', sha, 0);
      expect(calls.locate).toEqual([sha]);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(state().matches).toEqual(['b', sha]);
      expect(state().index).toBe(1);
      expect(selected()).toBe(sha);
      expect(state().message).toBeNull();
      // Not found: the revert stays a match, and the message says the commit itself isn't there.
      await setFindQuery('t', sha, 0);
      expect(calls.locate, 'now loaded: its own SHA matches, no locate').toEqual([sha]);
      vi.mocked(api.findText).mockImplementation(async () => ['b']);
      const missing = 'f'.repeat(40);
      await setFindQuery('t', missing, 0);
      expect(calls.locate).toEqual([sha, missing]);
      expect(state().matches).toEqual(['b']);
      expect(state().message).toBe('Not in the loaded history');
    } finally {
      useRuntime.setState({ refresh: realRefresh });
      vi.mocked(api.findText).mockImplementation(realText);
    }
  });

  it('a superseded or closed query still resolves its promise', async () => {
    vi.useFakeTimers();
    try {
      openFind('t');
      let first = false, second = false;
      void setFindQuery('t', 'x').then(() => { first = true; });
      void setFindQuery('t', 'xy').then(() => { second = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(first).toBe(true);
      closeFind('t');
      await vi.advanceTimersByTimeAsync(0);
      expect(second).toBe(true);
      expect(calls.text).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rerunFind (a refreshed graph) recomputes the matches without moving the selection', async () => {
    openFind('t');
    await setFindQuery('t', 'x', 0);
    stepFind('t', 1);
    expect(selected()).toBe('c');
    store().setGraph(graphOf(['c', 'a', 'b']));
    await rerunFind('t');
    expect(state().matches).toEqual(['c', 'a']);
    expect(state().index).toBe(0);
    expect(selected()).toBe('c');
  });

  it('searchOlder lists older hits; revealOlder loads their window', async () => {
    openFind('t');
    await setFindQuery('t', 'old', 0);
    await searchOlder('t');
    expect(state().older?.map((h) => h.summary)).toEqual(['old']);
    // Not found within the locate limit and not loaded: says so.
    await revealOlder('t', 'e'.repeat(40));
    expect(state().message).toMatch(/deeper than 10,000 commits/);
    // A new query drops the older list.
    await setFindQuery('t', 'x', 0);
    expect(state().older).toBeNull();
  });

  it('openFind bumps focusRequest every time (Ctrl+F on an open box refocuses it)', () => {
    openFind('t');
    const n = state().focusRequest;
    openFind('t');
    expect(state().focusRequest).toBe(n + 1);
    expect(state().open).toBe(true);
  });
});
