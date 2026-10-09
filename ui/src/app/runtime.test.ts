import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';

const graphCalls: Array<{ rescan?: boolean }> = [];
let release: () => void = () => {};
let gate = true;
const payload = (ids: string[] = []): GraphPayload => ({
  rows: ids.map((id) => ({ id, kind: 'commit', lane: 0, color: 0, parents: [], summary: id, bodyFirstLine: '', authorName: 'a', authorEmail: 'a@x', committerTime: 0, wip: null, mrRefs: [] }) as unknown as GraphPayload['rows'][number]),
  labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [],
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

const { useRuntime, migrateLinked } = await import('./runtime');
const { tabStore } = await import('./tabStores');
const { useAppState, EMPTY_PROFILE, EMPTY_REPO_SETTINGS } = await import('./state');
const { readWipDraft, writeWipDraft } = await import('../commit/draft');
const { centerViewOf, openCenterView, registerCenterView } = await import('../repo/centerView');
registerCenterView('runtimeProbe', () => null);

const ready = (id = 1) => ({ status: 'ready' as const, error: null, repo: { id, path: '/r', name: 'r', worktree: '/r' }, graph: null, info: null, sidebar: null, lastFetchAt: 0, fetchSkipped: null, limit: null, worktree: null });

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

  it('a closed tab\'s center view goes with it (spec #3)', () => {
    openCenterView('t', 'runtimeProbe', {});
    openCenterView('u', 'runtimeProbe', {});
    useRuntime.getState().drop('t');
    expect(centerViewOf('t')).toBeNull();
    expect(centerViewOf('u')).not.toBeNull();
  });

  it('open: a tab closed while its openRepo runs leaves no runtime and no recent entry, success or failure', async () => {
    const tabs = [{ id: 'o', kind: 'repo' as const, path: '/r', alias: null }];
    for (const fails of [false, true]) {
      useRuntime.setState({ tabs: {} });
      useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'default', tabs, activeTab: 'o' } });
      let answer!: () => void;
      api.openRepo.mockImplementation(() => new Promise((res, rej) => { answer = () => (fails ? rej(new Error('no repo')) : res({ id: 7, path: '/r', name: 'r', worktree: '/r' })); }));
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
    api.openRepo.mockImplementation(async () => ({ id: 7, path: '/r', name: 'r', worktree: '/r' }));
    await Promise.all([useRuntime.getState().open('o', '/r'), useRuntime.getState().open('o', '/r')]);
    expect(api.openRepo).toHaveBeenCalledOnce();
    expect(useRuntime.getState().tabs.o).toMatchObject({ status: 'ready', repo: { id: 7 } });
    expect(useAppState.getState().profile.recent[0]).toMatchObject({ path: '/r', name: 'r' });
  });

  describe('a tab is a repository and a worktree (spec #2 §11.2)', () => {
    const seedTab = (path: string, worktree?: string | null) => {
      useRuntime.setState({ tabs: {} });
      useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 'w', kind: 'repo', path, alias: null, ...(worktree !== undefined && { worktree }) }], activeTab: 'w', recent: [] } });
      return 'w';
    };

    it("keeps the opened worktree as the tab's and passes it to the graph", async () => {
      gate = false;
      api.openRepo.mockReset();
      api.openRepo.mockResolvedValue({ id: 7, path: '/r', name: 'r', worktree: '/r-x' });
      const tabId = seedTab('/r-x');
      await useRuntime.getState().open(tabId, '/r-x');
      expect(useRuntime.getState().tabs[tabId]?.worktree).toBe('/r-x');
      expect(api.graph).toHaveBeenLastCalledWith(7, expect.anything(), expect.objectContaining({ active: '/r-x' }));
      const tab = useAppState.getState().profile.tabs.find((t) => t.id === tabId)!;
      expect([tab.path, tab.worktree]).toEqual(['/r', '/r-x']);
      // Recent remembers the worktree the user opened, by its folder name.
      expect(useAppState.getState().profile.recent[0]).toMatchObject({ path: '/r-x', name: 'r-x' });
    });

    it('a saved worktree wins over the one the path opens', async () => {
      gate = false;
      api.openRepo.mockReset();
      api.openRepo.mockResolvedValue({ id: 7, path: '/r', name: 'r', worktree: '/r' });
      const tabId = seedTab('/r', '/r-y');
      await useRuntime.getState().open(tabId, '/r');
      expect(useRuntime.getState().tabs[tabId]?.worktree).toBe('/r-y');
      expect(graphCalls.at(-1)).toMatchObject({ active: '/r-y' });
      // Recent names the worktree the tab shows, not the path it was opened with (review M6).
      expect(useAppState.getState().profile.recent[0]).toMatchObject({ path: '/r-y', name: 'r-y' });
    });

    it("migrating a linked tab keeps its per-repo settings and its unsent WIP drafts (review I1)", async () => {
      gate = false;
      api.openRepo.mockReset();
      api.openRepo.mockResolvedValue({ id: 7, path: '/r', name: 'r', worktree: '/r-x' });
      const tabId = seedTab('/r-x');
      const settings = { ...EMPTY_REPO_SETTINGS, pin: { kind: 'off' as const } };
      useAppState.setState({ profile: { ...useAppState.getState().profile, repos: { '/r-x': settings } } });
      writeWipDraft('/r-x', '/r-x', { summary: 'Unsent fix', description: '' });
      await useRuntime.getState().open(tabId, '/r-x');
      expect(useAppState.getState().profile.repos['/r']).toEqual(settings);
      expect(readWipDraft('/r', '/r-x').summary).toBe('Unsent fix');
    });

    // --- 2C T10: the active worktree in the runtime ---
    it('marks the sidebar for the active worktree after a load', async () => {
      gate = false;
      api.openRepo.mockReset();
      api.openRepo.mockResolvedValue({ id: 7, path: '/r', name: 'r', worktree: '/r-x' });
      api.sidebar.mockResolvedValue({ locals: [{ name: 'x', fullName: 'refs/heads/x', isHead: false, worktree: '/r-x', checkedOut: '/r-x' }, { name: 'main', fullName: 'refs/heads/main', isHead: true, worktree: null, checkedOut: '/r' }], remotes: [], worktrees: [{ path: '/r', isCurrent: true }, { path: '/r-x', isCurrent: false }], stashes: [], tags: [] });
      const tabId = seedTab('/r-x');
      await useRuntime.getState().open(tabId, '/r-x');
      const s = useRuntime.getState().tabs[tabId]!.sidebar!;
      expect(s.locals.map((b) => [b.name, b.isHead, b.worktree])).toEqual([['x', true, null], ['main', false, '/r']]);
      expect(s.worktrees.map((w) => w.isCurrent)).toEqual([false, true]);
    });

    /** Review Focus 5. */
    it('a_missing_active_worktree_falls_back_to_the_main_one', async () => {
      gate = false;
      api.openRepo.mockReset();
      api.openRepo.mockResolvedValue({ id: 7, path: '/r', name: 'r', worktree: '/r' });
      api.graph.mockImplementation(async (_repo: number, _limit: number, extra: { active?: string }) => {
        if (extra.active === '/gone') throw new Error('/gone is not a worktree of this repository');
        return nextGraph;
      });
      const tabId = seedTab('/r', '/gone');
      await useRuntime.getState().open(tabId, '/r');
      expect(useRuntime.getState().tabs[tabId]?.status).toBe('ready');
      expect(useRuntime.getState().tabs[tabId]?.worktree).toBe('/r');
      expect(useAppState.getState().profile.tabs.find((t) => t.id === tabId)?.worktree).toBe('/r');
      expect(api.graph).toHaveBeenLastCalledWith(7, expect.anything(), expect.objectContaining({ active: '/r' }));
    });
    // --- end 2C T10 ---

    it("the repository's own settings win over a linked tab's old ones", () => {
      const own = { ...EMPTY_REPO_SETTINGS, pin: { kind: 'auto' as const } };
      const old = { ...EMPTY_REPO_SETTINGS, pin: { kind: 'off' as const } };
      const p = { ...EMPTY_PROFILE, repos: { '/r': own, '/r-x': old } };
      expect(migrateLinked(p, ['/r-x'], '/r').repos['/r']).toBe(own);
      expect(migrateLinked(p, ['/r'], '/r')).toBe(p);
    });
  });
});
