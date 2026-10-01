import { api } from '../api/client';

const desired = new Map<number, boolean>();
const running = new Map<number, Promise<void>>();

/**
 * Watch or unwatch a repo (spec §4.4: only the active tab is watched). Calls for one repo are
 * applied one at a time and coalesce to the latest wish, so an effect's quick
 * mount → unmount → mount (StrictMode, fast tab switching) can't end with the repo unwatched.
 * Resolves once the repo's latest wish has been applied (a failure is logged, not thrown): a tab
 * refreshes after its `watchRepo` returns, since the watcher's first pass has then refreshed the
 * backend's status cache (W2-B: watch, then a plain `graph`).
 */
export function setWatched(repo: number, on: boolean): Promise<void> {
  desired.set(repo, on);
  const cur = running.get(repo);
  if (cur) return cur;
  const run = (async () => {
    let applied: boolean | undefined;
    while (desired.get(repo) !== applied) {
      const want = desired.get(repo)!;
      try {
        await (want ? api.watchRepo(repo) : api.unwatchRepo(repo));
      } catch (e) {
        console.warn('[gitbolt] watch update failed', e);
      }
      applied = want;
    }
    running.delete(repo);
  })();
  running.set(repo, run);
  return run;
}
