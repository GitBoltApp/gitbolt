import type { ConflictKind } from '../api/gen/ConflictKind';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { InProgress } from '../api/gen/InProgress';

/**
 * UX round 2: conflicts are worded in the merge tool's own terms, current and incoming (named by
 * branch when known, as its pane titles are), never git's "us" and "them".
 *
 * Git's "us" is the index's stage 2, HEAD: the commit being built on. That's the merge tool's
 * current side in every operation, though a rebase swaps what it means to the user: there HEAD is
 * the branch being rebased onto, and "them" the user's own commit being replayed. So
 * `deletedByUs` is always "deleted in current"; only the names differ:
 * - merge: current = the checked-out branch, incoming = the merged branch;
 * - rebase: current = the onto branch, incoming = the rebased branch (its commit being replayed);
 * - cherry-pick: current = the checked-out branch, incoming = the picked commit;
 * - revert: current = the checked-out branch, incoming = the revert of the commit.
 */
export interface ConflictSides { current: string | null; incoming: string | null }

const short = (oid: string) => oid.slice(0, 7);
export const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, '');
/** The branch a merge's message names ("Merge branch 'feature/x'"). */
export const mergedName = (message: string) => /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(message)?.[1] ?? null;

/** Each side's name for operation `p` (`null`: unknown). `branch`: the worktree's checked-out
 * branch; `nameAt`: a branch at a commit; `target`: a GitBolt-started op's own target name. */
export function conflictSides(p: InProgress | null, branch: string | null, nameAt: (sha: string) => string | null = () => null, target: string | null = null): ConflictSides {
  const here = branch ? branchOf(branch) : null;
  switch (p?.kind) {
    case 'merge':
      return { current: here, incoming: target ?? mergedName(p.message) ?? short(p.mergeHead) };
    case 'rebase':
      return { current: target ?? nameAt(p.onto) ?? short(p.onto), incoming: p.headName ? branchOf(p.headName) : p.stoppedAt ? short(p.stoppedAt) : null };
    case 'cherryPick':
      return { current: here, incoming: p.head ? short(p.head) : null };
    case 'revert':
      return { current: here, incoming: p.head ? `revert of ${short(p.head)}` : null };
    default:
      return { current: null, incoming: null };
  }
}

/** A local branch at `sha` in the graph (else a remote one), as the user typed it. */
export const nameAtIn = (graph: Pick<GraphPayload, 'rows' | 'labels'>) => (sha: string): string | null => {
  const row = graph.rows.findIndex((r) => r.id === sha);
  const here = graph.labels.filter((l) => l.row === row && !l.tag);
  const local = here.find((l) => l.local)?.local?.replace(/^refs\/heads\//, '');
  const remote = here.flatMap((l) => l.remotes)[0]?.fullName.replace(/^refs\/remotes\//, '');
  return local ?? remote ?? null;
};
/** The worktree's checked-out branch (its ref), from the graph. */
export const branchIn = (graph: Pick<GraphPayload, 'worktrees'>, worktree: string) => graph.worktrees.find((w) => w.path === worktree)?.branch ?? null;

/** `conflictSides` of the worktree's operation, read off the graph. */
export const sidesIn = (graph: GraphPayload, worktree: string, target: string | null = null): ConflictSides =>
  conflictSides(graph.inProgress?.[worktree] ?? null, branchIn(graph, worktree), nameAtIn(graph), target);

/** A conflicted row's short status (the file list). */
export const CONFLICT_LABEL: Record<ConflictKind, string> = {
  bothModified: 'changed in both',
  bothAdded: 'added in both',
  bothDeleted: 'deleted in both',
  addedByUs: 'added in current',
  addedByThem: 'added in incoming',
  deletedByUs: 'deleted in current',
  deletedByThem: 'deleted in incoming',
};

/** The conflict in a sentence, its sides named: "Deleted in main (current), modified in
 * feature/x (incoming)". An unknown name is the side's alone ("current"). */
export function conflictSentence(kind: ConflictKind, sides: ConflictSides): string {
  const c = sides.current ? `${sides.current} (current)` : 'current';
  const i = sides.incoming ? `${sides.incoming} (incoming)` : 'incoming';
  switch (kind) {
    case 'bothModified': return `Changed in both ${c} and ${i}`;
    case 'bothAdded': return `Added in both ${c} and ${i}`;
    case 'bothDeleted': return `Deleted in both ${c} and ${i}`;
    case 'addedByUs': return `Added in ${c} only`;
    case 'addedByThem': return `Added in ${i} only`;
    case 'deletedByUs': return `Deleted in ${c}, modified in ${i}`;
    case 'deletedByThem': return `Modified in ${c}, deleted in ${i}`;
  }
}
