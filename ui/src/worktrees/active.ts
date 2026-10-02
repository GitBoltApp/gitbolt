import type { GraphPayload } from '../api/gen/GraphPayload';
import type { HeadPayload } from '../api/gen/HeadPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import { selectCommit } from '../app/graphNav';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { feedTabView, tabView } from '../app/tabStores';
import { loadJournal } from '../undo/store';
import { useToast } from '../ui/toast';
import { worktreeDisplay } from './paths';
import { openRepoTab, tabWorktree } from '../app/tabs';

/**
 * The tab's active worktree (spec #2 §11.2): the one its HEAD marker, WIP panel, commit box,
 * staging and Undo target. Switching changes only that: the graph, refs and every worktree's
 * status are shared and already loaded, so the markers are re-derived here from
 * `GraphPayload.worktrees` and the labels' `checkedOut`, with no request. Only the row-0 WIP
 * re-placement comes from the backend (Deviation 1).
 */

const priority = (l: RefLabel) => (l.isHead ? 0 : l.local !== null ? 1 : !l.tag ? 2 : 3);
const isDetachedHead = (l: RefLabel) => l.isHead && l.local === null && !l.tag && l.remotes.length === 0;
const memo = new WeakMap<GraphPayload, Map<string, GraphPayload>>();

/** The graph's HEAD marker, labels and open worktree for `active`; rows unchanged. */
export function withActive(g: GraphPayload, active: string): GraphPayload {
  const cached = memo.get(g)?.get(active);
  if (cached) return cached;
  const wt = g.worktrees.find((w) => w.path === active);
  if (!wt) return g;
  const head: HeadPayload = { branch: wt.branch, target: wt.head, detached: wt.branch === null && wt.head !== null, unborn: wt.head === null };
  const labels: RefLabel[] = g.labels
    .filter((l) => !isDetachedHead(l))
    .map((l) => (l.local === null ? l : { ...l, isHead: l.checkedOut === active, worktree: l.checkedOut !== null && l.checkedOut !== active ? l.checkedOut : null }));
  if (head.detached && head.target) {
    const row = g.rows.findIndex((r) => r.id === head.target);
    if (row >= 0) labels.push({ row, name: 'HEAD', local: null, remotes: [], tag: false, isHead: true, worktree: null, checkedOut: active });
  }
  labels.sort((a, b) => a.row - b.row || priority(a) - priority(b));
  const out: GraphPayload = { ...g, head, labels, openWorktree: active };
  if (!memo.has(g)) memo.set(g, new Map());
  memo.get(g)!.set(active, out);
  return out;
}

/** The sidebar (the handle's, read once for every tab) marking the tab's own current branch and worktree. */
export function withActiveSidebar(s: SidebarPayload, active: string): SidebarPayload {
  return {
    ...s,
    locals: s.locals.map((b) => ({ ...b, isHead: b.checkedOut === active, worktree: b.checkedOut !== null && b.checkedOut !== active ? b.checkedOut : null })),
    worktrees: s.worktrees.map((w) => ({ ...w, isCurrent: w.path === active })),
  };
}

export const activeWorktreeOf = (tabId: string): string | null => useRuntime.getState().tabs[tabId]?.worktree ?? null;
export const mainWorktreeOf = (tabId: string): string | null => {
  const rt = useRuntime.getState().tabs[tabId];
  return rt?.graph?.worktrees.find((w) => w.isMain)?.path ?? rt?.repo?.path ?? null;
};

const tabViewSelectionIsWip = (tabId: string) => tabView(tabId)?.store.getState().selection.kind === 'wip';

/**
 * Makes `path` the tab's active worktree. Synchronous and local: the markers, the sidebar, the
 * WIP panel and the commit box change in one render from data already loaded. The journal comes
 * from the store `Banners` keeps loaded per (repo, worktree), so a switch adds no request for
 * it. The one backend call is the graph-only relayout for row 0 (the active worktree's WIP is
 * "now", so lanes move), from the handle's cached walk: no sidebar, repo info or rescan, and
 * rapid switches coalesce into one.
 */
export function setActiveWorktree(tabId: string, path: string): void {
  const rt = useRuntime.getState().tabs[tabId];
  if (!rt?.repo || !rt.graph || rt.worktree === path || !rt.graph.worktrees.some((w) => w.path === path)) return;
  // Another tab already shows this worktree: go there rather than make two tabs of one.
  const app = useAppState.getState();
  const twin = app.profile.tabs.find((t) => t.id !== tabId && t.kind === 'repo' && t.path === rt.repo!.path && tabWorktree(t) === path);
  if (twin) {
    app.setProfile({ ...app.profile, activeTab: twin.id });
    useToast.getState().show(`${worktreeDisplay(mainWorktreeOf(tabId) ?? rt.repo.path, path)} is already open in another tab`);
    return;
  }
  const t0 = performance.now();
  const graph = withActive(rt.graph, path);
  const wasWip = tabViewSelectionIsWip(tabId);
  useRuntime.getState().patch(tabId, { worktree: path, graph, ...(rt.sidebar && { sidebar: withActiveSidebar(rt.sidebar, path) }) });
  feedTabView(tabId, rt.repo, graph);
  // A WIP row selected: the panel follows to the new active worktree's (when it has changes).
  if (wasWip) selectCommit(tabId, `wip:${path}`);
  app.updateProfile((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, worktree: path } : t)) }));
  requestAnimationFrame(() => console.info(`[gitbolt] worktree switch in ${Math.round(performance.now() - t0)} ms`));
  // Undo and Ctrl+Z need this worktree's journal now: load it in the background (never awaited).
  void loadJournal(rt.repo.id, path);
  void useRuntime.getState().refresh(tabId, { graphOnly: true });
}

/** Open in a new tab (§11.2): the same repository handle, another active worktree. */
export async function openWorktreeTab(tabId: string, path: string): Promise<void> {
  const rt = useRuntime.getState().tabs[tabId];
  if (!rt?.repo) return;
  const app = useAppState.getState();
  const r = openRepoTab(app.profile, rt.repo.path, path);
  app.setProfile(r.profile);
  if (!useRuntime.getState().tabs[r.tabId]?.repo) await useRuntime.getState().open(r.tabId, path);
}
