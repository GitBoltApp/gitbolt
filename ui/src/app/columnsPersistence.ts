import { columnPrefsPersistence, hiddenColumnsPersistence, useColumnPrefs } from '../graph/columns';
import { useAppState } from './state';

let installed = false;

/**
 * Plugs the graph's per-repo column seams (spec §8.4) into the active profile: `repoId` is the
 * canonical repo path, and `repos[path]` keeps the widths (`columns`, SHA included) and the
 * hidden columns (`hiddenColumns`). Called once at startup. A profile switch drops the widths the
 * graph holds, so the next graph loads the new profile's.
 */
export function installColumnPersistence(): void {
  if (installed) return;
  installed = true;
  columnPrefsPersistence.load = (repoId) => {
    const c = useAppState.getState().profile.repos[repoId]?.columns;
    return c ? { labels: c.labels, graph: c.graph, author: c.author, date: c.date, sha: c.sha, message: c.message ?? null } : null;
  };
  columnPrefsPersistence.save = (repoId, prefs) => {
    useAppState.getState().updateRepo(repoId, (r) => ({ ...r, columns: { labels: prefs.labels, graph: prefs.graph, author: prefs.author, date: prefs.date, sha: prefs.sha, message: prefs.message } }));
  };
  hiddenColumnsPersistence.load = (repoId) => useAppState.getState().profile.repos[repoId]?.hiddenColumns ?? null;
  hiddenColumnsPersistence.save = (repoId, hidden) => {
    useAppState.getState().updateRepo(repoId, (r) => ({ ...r, hiddenColumns: [...hidden] }));
  };
  useAppState.subscribe((s, prev) => {
    if (s.profile.id !== prev.profile.id) useColumnPrefs.getState().reset();
  });
}
