import type { BlobSource } from '../api/gen/BlobSource';
import type { FileCommit } from '../nav/history';
import type { DiffTarget, RepoViewState } from '../repo/store';

/** 5C (R9): the commits a Markdown diff's two sides resolve their relative links and images
 * against; `null` where a side has none (an added or deleted file) or it isn't known. */
export interface DiffSides { old: FileCommit | null; new: FileCommit | null }

/** A side's own source, when it names its commit (or the working tree, or nothing); `undefined`
 * for a blob, whose commit the selection says. */
const ofSource = (b: BlobSource): FileCommit | null | undefined =>
  b.kind === 'atCommit' ? b.commit : b.kind === 'worktree' ? 'worktree' : b.kind === 'absent' ? null : undefined;

/**
 * The old side's commit (R9): a commit's shown parent, a compare's FROM, a WIP row's worktree HEAD
 * (its row's only parent; the index has no commit of its own, R8). `null`: no old side, or not
 * known (a multi-selection).
 */
export function oldCommitOf(s: Pick<RepoViewState, 'selection' | 'parent' | 'graph' | 'indexById'>, t: DiffTarget): FileCommit | null {
  const own = ofSource(t.old);
  if (own !== undefined) return own;
  switch (s.selection.kind) {
    case 'commit': {
      const i = s.indexById.get(s.selection.id);
      return (i === undefined ? undefined : s.graph.rows[i]?.parents[s.parent]) ?? null;
    }
    case 'compare':
    case 'compareWorktree':
      return s.selection.from;
    case 'wip':
      return s.graph.rows[s.selection.index]?.parents[0] ?? null;
    default:
      return null;
  }
}
