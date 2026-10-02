// Test-only helpers for the app shell's keys: put a RepoViewStore behind an active tab, so the
// app's shortcuts (Ctrl+W, …) act on it the way they do in the app. Nothing in the app imports
// this module.
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { TabState } from '../api/gen/TabState';
import { createRepoViewStore, type RepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { EMPTY_PROFILE, useAppState } from './state';
import { useTabViews } from './tabStores';

export const EMPTY_GRAPH: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };

const repoTab = (id: string): TabState => ({ id, kind: 'repo', path: `/${id}`, alias: null });

/** A profile with repo tabs `ids` (the first active), and `store` (or a fresh one) as the
 * active tab's view. */
export function activeTabWith(store?: RepoViewStore, ids: string[] = ['t', 'u']): RepoViewStore {
  const s = store ?? createRepoViewStore(1, `/${ids[0]}`, EMPTY_GRAPH, fakeServices());
  useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: ids.map(repoTab), activeTab: ids[0] } });
  useTabViews.setState({ views: { [ids[0]]: { repo: 1, services: s.getState().services, store: s } } });
  return s;
}
