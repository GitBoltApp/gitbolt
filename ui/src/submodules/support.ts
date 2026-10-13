import type { SubmoduleSupport } from '../api/gen/SubmoduleSupport';
import { useRuntime } from '../app/runtime';

/** What `repoInfo` says of worktree `worktree` of tab `tabId`: `undefined` when it uses no
 * submodules (the submodule actions don't show there). */
export const supportOf = (tabId: string, worktree: string): SubmoduleSupport | undefined => useRuntime.getState().tabs[tabId]?.info?.submodules[worktree];

/** Why git's submodule commands can't run in a worktree: a gitlink `.gitmodules` doesn't map. */
export function unmappedReason(s: SubmoduleSupport): string | undefined {
  const [first, ...rest] = s.unmapped;
  if (first === undefined) return undefined;
  const which = rest.length ? `${first} and ${rest.length} more have` : `${first} has`;
  return `${which} no entry in .gitmodules: git's submodule commands can't run in this worktree`;
}
