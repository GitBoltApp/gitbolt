import type { RepoProjects } from '../api/gen/RepoProjects';
import { hostName } from '../remotes/match';

/** The remotes with a project on `host` (`forgeRepoProjects`, spec #4 §3.3): the Create flyout's
 * From and To choices. The target project is 4B's `forgeOf(tabId)`, not kept again here. */
export function mappedRemotes(p: RepoProjects | null | undefined, host: string): string[] {
  return (p?.remotes ?? []).filter((r) => hostName(r.project?.host) === hostName(host)).map((r) => r.remote);
}
