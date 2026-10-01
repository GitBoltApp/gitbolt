import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RepoInfoPayload } from '../api/gen/RepoInfoPayload';
import type { RepoSummary } from '../api/gen/RepoSummary';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import { useAppState } from './state';
import { dropTabView, feedTabView } from './tabStores';
import { openRepoTab, setTabRepo, touchRecent } from './tabs';

/** One tab's loaded repo (not persisted: the profile holds only the tab's path). */
export interface TabRuntime {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  repo: RepoSummary | null;
  graph: GraphPayload | null;
  info: RepoInfoPayload | null;
  sidebar: SidebarPayload | null;
  /** ms epoch of the last fetch attempt; 0 = never. */
  lastFetchAt: number;
  /** Status-bar warning after a background fetch was skipped for credentials. */
  fetchSkipped: string | null;
  /** Commit window override (find: a hash deeper than the default window); null = setting. */
  limit: number | null;
}

const EMPTY: TabRuntime = { status: 'loading', error: null, repo: null, graph: null, info: null, sidebar: null, lastFetchAt: 0, fetchSkipped: null, limit: null };

interface RuntimeState {
  tabs: Record<string, TabRuntime>;
  patch(tabId: string, patch: Partial<TabRuntime>): void;
  /** Forgets a closed tab: its runtime and its 1B view state. */
  drop(tabId: string): void;
  open(tabId: string, path: string): Promise<void>;
  /** `graphOnly` skips the sidebar and repo-info reads (a worktree/index-only change). */
  refresh(tabId: string, opts?: { rescan?: boolean; graphOnly?: boolean }): Promise<void>;
}

/** The tab is (still) in the active profile. */
const tabOpen = (tabId: string) => useAppState.getState().profile.tabs.some((t) => t.id === tabId);

const inflight = new Map<string, Promise<void>>();
const queued = new Map<string, { rescan: boolean; side: boolean }>();
const opening = new Map<string, Promise<void>>();

const warned = new Set<string>();
/** A side read (sidebar, repo info) that failed: logged once per kind of failure, and the tab
 * keeps what it had. The graph is what makes a tab usable. */
function sideRead<T>(what: string, p: Promise<T>): Promise<T | undefined> {
  return p.catch((e: unknown) => {
    const msg = `${what}: ${errorMessage(e)}`;
    if (!warned.has(msg)) {
      warned.add(msg);
      console.warn(`[gitbolt] ${msg}`);
    }
    return undefined;
  });
}

async function load(tabId: string, rescan: boolean, side: boolean): Promise<void> {
  const rt = useRuntime.getState().tabs[tabId];
  if (!rt?.repo) return;
  const repo = rt.repo;
  const { settings, profile } = useAppState.getState();
  const pin = profile.repos[repo.path]?.pin ?? undefined;
  // Still the same tab on the same repo (not closed, or re-pointed, meanwhile).
  const current = () => useRuntime.getState().tabs[tabId]?.repo?.id === repo.id;
  try {
    const [graph, sidebar, info] = await Promise.all([
      // `rescan` only when asked: a watched repo's status cache is kept fresh (W2-B).
      api.graph(repo.id, rt.limit ?? settings.commitLimit, rescan ? { pin, rescan } : { pin }),
      // A worktree/index-only change can't alter refs, stashes or config: keep what's shown.
      side ? sideRead('sidebar', api.sidebar(repo.id)) : Promise.resolve(undefined),
      side ? sideRead('repo info', api.repoInfo(repo.id)) : Promise.resolve(undefined),
    ]);
    if (!current()) return;
    feedTabView(tabId, repo, graph);
    useRuntime.getState().patch(tabId, { graph, status: 'ready', error: null, ...(sidebar && { sidebar }), ...(info && { info }) });
  } catch (e) {
    if (!current()) return;
    const cur = useRuntime.getState().tabs[tabId];
    useRuntime.getState().patch(tabId, cur?.graph ? { error: errorMessage(e) } : { status: 'error', error: errorMessage(e) });
  }
}

export const useRuntime = create<RuntimeState>((set, get) => ({
  tabs: {},
  patch(tabId, patch) {
    set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? EMPTY), ...patch } } }));
  },
  drop(tabId) {
    dropTabView(tabId);
    if (!(tabId in get().tabs)) return;
    set((s) => {
      const tabs = { ...s.tabs };
      delete tabs[tabId];
      return { tabs };
    });
  },
  open(tabId, path) {
    // The boot's `?repo=` open and the tab's own first activation can ask at once: one open.
    const running = opening.get(tabId);
    if (running) return running;
    const run = (async () => {
      const t0 = performance.now();
      get().patch(tabId, { status: 'loading', error: null });
      try {
        const repo = await api.openRepo(path);
        const app = useAppState.getState();
        // Closed meanwhile: nothing to show it in, and it wasn't really opened (no Recent entry).
        if (!tabOpen(tabId)) return get().drop(tabId);
        const next = touchRecent(setTabRepo(app.profile, tabId, repo.path), repo.path, repo.name);
        app.setProfile(next);
        if (!next.tabs.some((t) => t.id === tabId)) {
          get().drop(tabId); // it duplicated an open tab, which is now active instead
          return;
        }
        get().patch(tabId, { repo });
        // Plain: an unwatched repo's graph re-reads status anyway (the watch comes from RepoTab).
        await get().refresh(tabId);
        requestAnimationFrame(() => console.info(`[gitbolt] graph ready in ${Math.round(performance.now() - t0)} ms (${get().tabs[tabId]?.graph?.rows.length ?? 0} rows)`));
      } catch (e) {
        // Only for a tab that's still there: a closed one's runtime is gone for good.
        if (tabOpen(tabId)) get().patch(tabId, { status: 'error', error: errorMessage(e) });
        else get().drop(tabId);
      }
    })().finally(() => opening.delete(tabId));
    opening.set(tabId, run);
    return run;
  },
  refresh(tabId, opts = {}) {
    const running = inflight.get(tabId);
    if (running) {
      const q = queued.get(tabId);
      queued.set(tabId, { rescan: (q?.rescan ?? false) || !!opts.rescan, side: (q?.side ?? false) || !opts.graphOnly });
      return running;
    }
    const run = (async () => {
      let next: { rescan: boolean; side: boolean } | undefined = { rescan: !!opts.rescan, side: !opts.graphOnly };
      while (next !== undefined) {
        queued.delete(tabId);
        await load(tabId, next.rescan, next.side);
        next = queued.get(tabId);
      }
    })().finally(() => inflight.delete(tabId));
    inflight.set(tabId, run);
    return run;
  },
}));

/** Tabs (ids) showing repo `repoId`. */
export function tabsForRepo(repoId: number): string[] {
  return Object.entries(useRuntime.getState().tabs).filter(([, rt]) => rt.repo?.id === repoId).map(([id]) => id);
}

/**
 * Opens `path` in `tabId` (an Open tab, which becomes the repo tab only once the open succeeds, so
 * a failure leaves the Open screen showing the error), or in a new tab after the active one (or
 * focuses the tab that already shows it).
 */
export async function openPathInTab(path: string, tabId?: string): Promise<void> {
  const app = useAppState.getState();
  let id = tabId;
  if (id) {
    app.setProfile({ ...app.profile, activeTab: id });
  } else {
    const r = openRepoTab(app.profile, path);
    app.setProfile(r.profile);
    id = r.tabId;
  }
  if (!useRuntime.getState().tabs[id]?.repo) await useRuntime.getState().open(id, path);
}
