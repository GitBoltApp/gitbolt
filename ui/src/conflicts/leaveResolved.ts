import type { RepoServices } from '../repo/services';
import { targetFor, type RepoViewStore } from '../repo/store';
import { isWipKey, wipKey } from '../repo/wipLists';

/**
 * UX round 2: the open file (merge tool) was resolved — here, from a row's menu, Mark resolved,
 * a non-text prompt's buttons, a save. Run on each WIP list update (a write's fresh lists are
 * held at once; a watcher's `repoChanged` drops them, so it acts once a list is held again).
 * The tool mustn't keep offering its buttons: it moves to the
 * next conflicted file of the worktree (the one after it in the list, wrapping round), or closes
 * when none is left.
 *
 * Resolved means the held WIP list no longer has the file as conflicted, or `gone` names it (the
 * merge tool's own save: its answer said so, whatever list is held). No list held and no `gone`:
 * nothing is known, nothing moves. A no-op once the open file is another one.
 */
export function leaveResolved(store: RepoViewStore, services: { wip: Pick<RepoServices['wip'], 'peek'> }, gone?: string): void {
  const s = store.getState();
  const d = s.diff;
  if (!d || d.status !== 'U' || !isWipKey(d.key) || d.new.kind !== 'worktree') return;
  const worktree = d.new.worktree;
  const list = services.wip.peek(wipKey(worktree, false));
  const conflicted = list?.files.filter((f) => f.status === 'U') ?? [];
  if (gone !== d.path && (!list || conflicted.some((f) => f.path === d.path))) return;
  const rest = conflicted.filter((f) => f.path !== d.path);
  const next = rest.find((f) => f.path > d.path) ?? rest[0];
  if (next) s.openFile(targetFor(next, { kind: 'wip', worktree, staged: false }));
  else if (s.focus === 'diff') s.closeDiff();
  else s.closeDiffTo(s.focus);
}
