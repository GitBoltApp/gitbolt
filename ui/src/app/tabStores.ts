import { create } from 'zustand';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RepoSummary } from '../api/gen/RepoSummary';
import { createServices, type RepoServices } from '../repo/services';
import { createRepoViewStore, type RepoViewStore } from '../repo/store';

/**
 * Each repo tab's 1B view state (ruling R3): its `RepoViewStore` (selection, details panel, open
 * diff, focus) and `RepoServices` (the per-repo caches), by tab id. The tab's runtime makes them
 * on its first graph and feeds them every refresh; they go with the tab (`useRuntime.drop`), so a
 * hidden tab keeps its selection and open file. Everything in 1C that acts on a tab's view (the
 * seams, graph navigation, Ctrl+W, menus, find, the sidebar's focus zone, the palette) goes
 * through the tab's store, the way 1B's file menu does (`fileMenuEnv(store)`).
 */
export interface TabView { repo: number; services: RepoServices; store: RepoViewStore }

export const useTabViews = create<{ views: Record<string, TabView> }>(() => ({ views: {} }));

export const tabView = (tabId: string): TabView | undefined => useTabViews.getState().views[tabId];
export const tabStore = (tabId: string): RepoViewStore | undefined => tabView(tabId)?.store;

/** The tab a view store belongs to (menus build a write target from the store alone). */
export function tabIdOf(store: RepoViewStore): string | null {
  for (const [id, v] of Object.entries(useTabViews.getState().views)) if (v.store === store) return id;
  return null;
}

/** The tab's view, reactive (undefined until its first graph). */
export const useTabView = (tabId: string): TabView | undefined => useTabViews((s) => s.views[tabId]);

/** Makes the tab's view for `repo` on its first graph (or after the tab moved to another repo),
 * else hands it the new graph (1B's `setGraph` keeps the selection by commit id). */
export function feedTabView(tabId: string, repo: RepoSummary, graph: GraphPayload): RepoViewStore {
  const cur = tabView(tabId);
  if (cur && cur.repo === repo.id) {
    cur.store.getState().setGraph(graph);
    return cur.store;
  }
  const services = createServices(repo.id);
  const store = createRepoViewStore(repo.id, repo.path, graph, services);
  useTabViews.setState((s) => ({ views: { ...s.views, [tabId]: { repo: repo.id, services, store } } }));
  return store;
}

export function dropTabView(tabId: string): void {
  if (!tabView(tabId)) return;
  useTabViews.setState((s) => {
    const views = { ...s.views };
    delete views[tabId];
    return { views };
  });
}
