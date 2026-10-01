import { memo, useEffect, useMemo } from 'react';
import { onEvent } from '../api/client';
import { PanelErrorBoundary } from '../errors/PanelErrorBoundary';
import type { TabState } from '../api/gen/TabState';
import { useFetchScheduler } from './fetchSchedule';
import { RepoContext } from './repoContext';
import { useRuntime } from './runtime';
import { RepoView, RepoViewContext } from './seams1b';
import { TabSlot } from './slots';
import { tabView, useTabView } from './tabStores';
import { setWatched } from './watch';

/**
 * One repository tab. Rendered inside `<Activity>`: every effect below runs only while the tab
 * is visible, so an inactive tab has no watcher, no event subscription and no timers (spec §4.4,
 * Review Focus 1); its DOM, its 1B view state (selection, open file) and scroll survive.
 * While shown it:
 * - loads its repo on first show (restored tabs load lazily);
 * - runs the background fetch timer (spec §15; `fetchSchedule.ts`);
 * - watches its repo, and once re-shown and watched, updates in place (spec §4.4 "Activating a
 *   tab"); refreshes on `repoChanged` / `refsUpdated` for it;
 * - while watched, holds its WIP rows' file lists in memory, kept current by `repoChanged` (K44);
 * - provides `RepoContext`, and the tab's `RepoViewStore` as 1B's `RepoViewContext`, to its slots.
 *
 * Memoized: the profile's tab objects are stable across a switch (only `activeTab` changes), and so
 * is everything RepoView gets (the tab's graph, services and store), so a switch re-renders only
 * the tabs whose `<Activity>` mode changed, never every hidden tab's tree.
 */
export const RepoTab = memo(function RepoTab({ tab }: { tab: TabState }) {
  const rt = useRuntime((s) => s.tabs[tab.id]);
  const open = useRuntime((s) => s.open);
  const refresh = useRuntime((s) => s.refresh);
  const view = useTabView(tab.id);
  const repoId = rt?.repo?.id;

  // First show: open the repo (restored tabs load lazily).
  useEffect(() => {
    const cur = useRuntime.getState().tabs[tab.id];
    if (!cur?.repo && tab.path) void open(tab.id, tab.path);
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watch while shown. Re-shown with a graph already loaded, it's shown at once, then updated
  // in place once the watch is on (spec §4.4 "Activating a tab"): the watcher's first pass has
  // refreshed the backend's status cache by then, so a plain `graph` is current (W2-B; an
  // unwatched repo's graph always re-reads status). A first open doesn't wait: its graph is read
  // unwatched, and the watcher reports anything that changed between the two.
  useEffect(() => {
    if (repoId === undefined) return;
    let shown = true;
    const reshown = !!useRuntime.getState().tabs[tab.id]?.graph;
    void setWatched(repoId, true).then(() => {
      if (shown && reshown) void refresh(tab.id);
    });
    return () => {
      shown = false;
      void setWatched(repoId, false);
    };
  }, [repoId, tab.id, refresh]);

  // K44: the view holds its WIP rows' lists while the watch is up (the coalesced `setWatched`
  // resolves once it is), and drops them as soon as it's hidden.
  const store = view?.store;
  useEffect(() => {
    if (repoId === undefined || !store) return;
    let live = true;
    void setWatched(repoId, true).then(() => {
      if (live) store.getState().setWatched(true);
    });
    return () => {
      live = false;
      store.getState().setWatched(false);
    };
  }, [repoId, store]);

  useEffect(() => {
    if (repoId === undefined) return;
    return onEvent((ev) => {
      if (ev.type === 'repoChanged' && ev.repo === repoId) tabView(tab.id)?.services.wip.changed(ev.worktrees, ev.versions);
      if (ev.type !== 'repoChanged' && ev.type !== 'refsUpdated') return;
      if (ev.repo !== repoId) return;
      if (ev.type === 'refsUpdated') void refresh(tab.id);
      // Only refs, HEAD, stashes and config show in the sidebar and repo info; a worktree/index
      // change reloads the graph alone (1C review M5).
      else void refresh(tab.id, ev.kinds.some((k) => k === 'refs' || k === 'head' || k === 'stash' || k === 'config') ? {} : { graphOnly: true });
    });
  }, [repoId, tab.id, refresh]);

  // Background fetch (spec §15): this tab's timer lives only while it's shown.
  useFetchScheduler(tab.id, repoId);

  // The window title follows the active tab (1A's e2e checks `GitBolt — repo`).
  const repoName = rt?.repo?.name;
  useEffect(() => {
    if (repoName) document.title = `GitBolt — ${repoName}`;
  }, [repoName]);

  const repo = rt?.repo;
  const info = rt?.info ?? null;
  const ctx = useMemo(() => (repo ? { tabId: tab.id, repoId: repo.id, path: repo.path, info } : null), [tab.id, repo, info]);

  if (!rt || (rt.status === 'loading' && !rt.graph)) return <div className="center-message">Loading…</div>;
  if (!rt.graph || !repo || !ctx || !view) return <div className="center-message" role="alert">{rt.error}</div>;
  const graph = rt.graph;
  return (
    <RepoContext value={ctx}>
      <RepoViewContext value={view.store}>
        <div className="repo-tab" data-testid="repo-tab">
          <TabSlot name="toolbar" tab={tab} />
          <div className="repo-body">
            <PanelErrorBoundary name="Sidebar"><TabSlot name="sidebar" tab={tab} /></PanelErrorBoundary>
            <div className="center-slot">
              {graph.rows.length === 0 && graph.head.unborn
                ? <div className="center-message">No commits yet</div>
                : <RepoView key={repo.id} repo={repo.id} repoPath={repo.path} graph={graph} services={view.services} store={view.store} graphOverlay={<TabSlot name="graphOverlay" tab={tab} />} />}
            </div>
          </div>
        </div>
      </RepoViewContext>
    </RepoContext>
  );
});
