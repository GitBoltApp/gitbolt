import { create } from 'zustand';
import { pruneWipDrafts, rekeyWipDrafts } from '../commit/draft';
import { api, errorMessage } from '../api/client';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { Profile } from '../api/gen/Profile';
import type { RepoInfoPayload } from '../api/gen/RepoInfoPayload';
import type { RepoSummary } from '../api/gen/RepoSummary';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import { useAppState } from './state';
import { closeCenterView } from '../repo/centerView';
import { dropTabView, feedTabView } from './tabStores';
import { withActiveSidebar } from '../worktrees/active';
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
  /** The tab's active worktree (spec #2 §11.2), canonical as the backend spells it; null until
   * the repo is open. `repo` is the repository's handle, shared by every tab on it. */
  worktree: string | null;
}

const EMPTY: TabRuntime = { status: 'loading', error: null, repo: null, graph: null, info: null, sidebar: null, lastFetchAt: 0, fetchSkipped: null, limit: null, worktree: null };

/** The worktree a tab acts on: its active one, else (not open yet) its repository's path. */
export const worktreeOf = (rt: Pick<TabRuntime, 'repo' | 'worktree'> | undefined): string | null => rt?.worktree ?? rt?.repo?.path ?? null;

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

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

/** The graph's error for an active worktree that was removed (or never was one of the repository's). */
const GONE = 'is not a worktree of this repository';

async function load(tabId: string, rescan: boolean, side: boolean): Promise<void> {
  const rt = useRuntime.getState().tabs[tabId];
  if (!rt?.repo) return;
  const repo = rt.repo;
  const { settings, profile } = useAppState.getState();
  const pin = profile.repos[repo.path]?.pin ?? undefined;
  const worktree = rt.worktree;
  // Still the same tab on the same repo and worktree (not closed, or re-pointed, meanwhile).
  const current = () => {
    const now = useRuntime.getState().tabs[tabId];
    return now?.repo?.id === repo.id && now.worktree === worktree;
  };
  try {
    const [graph, sidebar, info] = await Promise.all([
      // `rescan` only when asked: a watched repo's status cache is kept fresh (W2-B). `active`:
      // the tab's worktree is laid out as the open one (spec #2 §11.2).
      api.graph(repo.id, rt.limit ?? settings.commitLimit, { ...(rescan ? { pin, rescan } : { pin }), ...(worktree ? { active: worktree } : {}) }),
      // A worktree/index-only change can't alter refs, stashes or config: keep what's shown.
      side ? sideRead('sidebar', api.sidebar(repo.id)) : Promise.resolve(undefined),
      side ? sideRead('repo info', api.repoInfo(repo.id)) : Promise.resolve(undefined),
    ]);
    if (!current()) {
      // Dropped for a switch: a sidebar/info read lost with it re-queues as a full refresh for
      // the now-current worktree (the follow-up would otherwise be graph-only).
      if (side) { const q = queued.get(tabId); queued.set(tabId, { rescan: q?.rescan ?? false, side: true }); }
      return;
    }
    feedTabView(tabId, repo, graph);
    // §8.2: drafts of worktrees that no longer exist go when the worktree list loads.
    if (sidebar?.worktrees.length) pruneWipDrafts(repo.path, sidebar.worktrees.map((w) => w.path));
    // The graph was laid out for `worktree` by the backend; the sidebar is the handle's (read
    // once for every tab), so its current branch and worktree are marked for this tab here.
    useRuntime.getState().patch(tabId, { graph, status: 'ready', error: null, ...(sidebar && { sidebar: withActiveSidebar(sidebar, worktree ?? repo.path) }), ...(info && { info }) });
  } catch (e) {
    if (!current()) return;
    // Review Focus 5: the active worktree is gone (removed elsewhere, or by this app): the tab
    // falls back to the repository's main one, in the runtime and in the saved tab.
    if (worktree && worktree !== repo.path && errorMessage(e).endsWith(GONE)) {
      useRuntime.getState().patch(tabId, { worktree: repo.path });
      useAppState.getState().updateProfile((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, worktree: repo.path } : t)) }));
      return load(tabId, rescan, side);
    }
    const cur = useRuntime.getState().tabs[tabId];
    useRuntime.getState().patch(tabId, cur?.graph ? { error: errorMessage(e) } : { status: 'error', error: errorMessage(e) });
  }
}

/**
 * Before 2C a linked worktree's tab was its own repository: its per-repo settings (pin, columns,
 * sidebar sort and sections, editor) and its WIP drafts were keyed by the worktree's path. They
 * are the repository's now, keyed by `repoPath`. A linked entry moves across when the repository
 * has none yet, and its unsent drafts are re-keyed, so nothing the user set or typed is lost.
 * The old settings entry stays (nothing prunes `profile.repos`).
 */
export function migrateLinked(p: Profile, linked: readonly string[], repoPath: string): Profile {
  const from = [...new Set(linked)].filter((l) => l !== repoPath);
  for (const l of from) rekeyWipDrafts(l, repoPath);
  const source = from.find((l) => p.repos[l]);
  if (!source || p.repos[repoPath]) return p;
  return { ...p, repos: { ...p.repos, [repoPath]: p.repos[source] } };
}

export const useRuntime = create<RuntimeState>((set, get) => ({
  tabs: {},
  patch(tabId, patch) {
    set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? EMPTY), ...patch } } }));
  },
  drop(tabId) {
    dropTabView(tabId);
    // Spec #3: a closed tab's center view (File History, the rebase editor) goes with it.
    closeCenterView(tabId);
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
        // A tab is `(repository, worktree)` (spec #2 §11.2): it keeps its saved worktree, else
        // the one opened (a tab saved before 2C on a linked worktree migrates here). Recent
        // remembers the worktree the tab shows, by its folder name as before.
        const saved = app.profile.tabs.find((t) => t.id === tabId)?.worktree ?? null;
        const worktree = saved ?? repo.worktree;
        const name = worktree === repo.path ? repo.name : basename(worktree);
        const migrated = migrateLinked(app.profile, [repo.worktree, worktree], repo.path);
        const next = touchRecent(setTabRepo(migrated, tabId, repo.path, worktree), worktree, name);
        app.setProfile(next);
        if (!next.tabs.some((t) => t.id === tabId)) {
          get().drop(tabId); // it duplicated an open tab, which is now active instead
          return;
        }
        get().patch(tabId, { repo, worktree });
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
    // No worktree yet: the backend names the one `path` is in on open (`RepoSummary.worktree`).
    const r = openRepoTab(app.profile, path, null);
    app.setProfile(r.profile);
    id = r.tabId;
  }
  if (!useRuntime.getState().tabs[id]?.repo) await useRuntime.getState().open(id, path);
}
