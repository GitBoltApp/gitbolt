import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';

const graphCalls: Array<{ rescan?: boolean }> = [];
let release: () => void = () => {};
let gate = true;
const payload = (ids: string[] = []): GraphPayload => ({
  rows: ids.map((id) => ({ id, kind: 'commit', lane: 0, color: 0, parents: [], summary: id, bodyFirstLine: '', authorName: 'a', authorEmail: 'a@x', committerTime: 0, wip: null, mrRefs: [] }) as unknown as GraphPayload['rows'][number]),
  labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: false }, truncated: false,
});
let nextGraph = payload();
const api = vi.hoisted(() => ({
  graph: vi.fn(),
  sidebar: vi.fn(),
  repoInfo: vi.fn(),
  openRepo: vi.fn(),
  saveProfile: vi.fn(async () => null),
  // What a selection loads (the store's details panel reads).
  commitDetails: vi.fn(async () => new Promise(() => {})),
  commitMessage: vi.fn(async () => new Promise(() => {})),
  fileList: vi.fn(async () => new Promise(() => {})),
}));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => String(e) }));

const { useRuntime } = await import('./runtime');
const { tabStore } = await import('./tabStores');
const { useAppState, EMPTY_PROFILE } = await import('./state');

const ready = (id = 1) => ({ status: 'ready' as const, error: null, repo: { id, path: '/r', name: 'r' }, graph: null, info: null, sidebar: null, lastFetchAt: 0, fetchSkipped: null, limit: null });

describe('runtime', () => {
  beforeEach(() => {
    graphCalls.length = 0;
    gate = true;
    nextGraph = payload();
    api.graph.mockImplementation(async (_repo: number, _limit: number, extra: { rescan?: boolean }) => {
      graphCalls.push(extra);
      if (gate) await new Promise<void>((r) => { release = r; });
      return nextGraph;
    });
    api.sidebar.mockImplementation(async () => ({ locals: [], remotes: [], worktrees: [], stashes: [], tags: [] }));
    api.repoInfo.mockImplementation(async () => ({ remotes: [], mainWorktree: null, commonDir: '/r/.git' }));
    useRuntime.setState({ tabs: { t: ready() } });
  });

  it('refresh is single-flight: calls during a run coalesce into one more run, keeping rescan', async () => {
    const first = useRuntime.getState().refresh('t');
    await vi.waitFor(() => expect(graphCalls).toHaveLength(1));
    void useRuntime.getState().refresh('t');
    void useRuntime.getState().refresh('t', { rescan: true });
    void useRuntime.getState().refresh('t');
    release();
    await vi.waitFor(() => expect(graphCalls).toHaveLength(2));
    release();
    await first;
    expect(graphCalls.map((c) => c.rescan)).toEqual([undefined, true]);
    expect(useRuntime.getState().tabs.t.status).toBe('ready');
  });

  it('graphOnly skips the sidebar and repo info; a coalesced full refresh wins (1C review M5)', async () => {
    gate = false;
    await useRuntime.getState().refresh('t');
    api.sidebar.mockClear();
    api.repoInfo.mockClear();
    await useRuntime.getState().refresh('t', { graphOnly: true });
    expect(api.sidebar).not.toHaveBeenCalled();
    expect(api.repoInfo).not.toHaveBeenCalled();
    gate = true;
    const first = useRuntime.getState().refresh('t', { graphOnly: true });
    await vi.waitFor(() => expect(graphCalls.length).toBeGreaterThan(0));
    void useRuntime.getState().refresh('t', { graphOnly: true });
    void useRuntime.getState().refresh('t');
    release();
    await vi.waitFor(() => expect(graphCalls.length).toBeGreaterThan(1));
    gate = false;
    release();
    await first;
    expect(api.sidebar).toHaveBeenCalledTimes(1);
    expect(api.repoInfo).toHaveBeenCalledTimes(1);
  });

  it('a failed sidebar or repo-info read keeps the graph (and the previous sidebar)', async () => {
    gate = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useRuntime.getState().refresh('t');
    const sidebar = useRuntime.getState().tabs.t.sidebar;
    expect(sidebar).not.toBeNull();
    api.sidebar.mockRejectedValue(new Error('unknown method'));
    api.repoInfo.mockRejectedValue(new Error('unknown method'));
    nextGraph = payload(['a']);
    await useRuntime.getState().refresh('t');
    const rt = useRuntime.getState().tabs.t;
    expect(rt.status).toBe('ready');
    expect(rt.graph?.rows).toHaveLength(1);
    expect(rt.sidebar).toBe(sidebar);
    warn.mockRestore();
  });

  it('owns the tab\'s RepoViewStore: made on the first graph, fed every later one, dropped with the tab', async () => {
    gate = false;
    nextGraph = payload(['a', 'b']);
    await useRuntime.getState().refresh('t');
    const store = tabStore('t')!;
    expect(store.getState().graph).toBe(nextGraph);
    expect(store.getState().selectCommitById('b')).toBe(true);
    nextGraph = payload(['new', 'a', 'b']);
    await useRuntime.getState().refresh('t');
    expect(tabStore('t')).toBe(store);
    expect(store.getState().graph).toBe(nextGraph);
    // setGraph remaps the selection by commit id (1B).
    expect(store.getState().selection).toMatchObject({ kind: 'commit', id: 'b', index: 2 });
    useRuntime.getState().drop('t');
    expect(tabStore('t')).toBeUndefined();
    expect(useRuntime.getState().tabs.t).toBeUndefined();
  });

  it('open: a tab closed while its openRepo runs leaves no runtime and no recent entry, success or failure', async () => {
    const tabs = [{ id: 'o', kind: 'repo' as const, path: '/r', alias: null }];
    for (const fails of [false, true]) {
      useRuntime.setState({ tabs: {} });
      useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'default', tabs, activeTab: 'o' } });
      let answer!: () => void;
      api.openRepo.mockImplementation(() => new Promise((res, rej) => { answer = () => (fails ? rej(new Error('no repo')) : res({ id: 7, path: '/r', name: 'r' })); }));
      const opening = useRuntime.getState().open('o', '/r');
      await vi.waitFor(() => expect(api.openRepo).toHaveBeenCalled());
      // The tab closes (AppShell drops its runtime), then the open settles.
      useAppState.setState({ profile: { ...useAppState.getState().profile, tabs: [], activeTab: null } });
      useRuntime.getState().drop('o');
      answer();
      await opening;
      expect(useRuntime.getState().tabs.o).toBeUndefined();
      expect(useAppState.getState().profile.recent).toEqual([]);
      expect(useAppState.getState().profile.tabs).toEqual([]);
      api.openRepo.mockReset();
    }
  });

  it('open: concurrent calls for one tab share one openRepo', async () => {
    gate = false;
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 'o', kind: 'repo', path: '/r', alias: null }], activeTab: 'o' } });
    api.openRepo.mockImplementation(async () => ({ id: 7, path: '/r', name: 'r' }));
    await Promise.all([useRuntime.getState().open('o', '/r'), useRuntime.getState().open('o', '/r')]);
    expect(api.openRepo).toHaveBeenCalledOnce();
    expect(useRuntime.getState().tabs.o).toMatchObject({ status: 'ready', repo: { id: 7 } });
    expect(useAppState.getState().profile.recent[0]).toMatchObject({ path: '/r', name: 'r' });
  });
});
