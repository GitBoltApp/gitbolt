import type { FileTarget } from '../menu/menuEnv';
import { parseListSpec } from '../openIn/openers';
import type { HistoryStart } from './open';

/** Where a file row's history starts (ruling 1): its commit's version (a deleted file: the
 * parent's, `FileTarget.sha`), or a WIP row's worktree HEAD. `null`: a file new in the WIP. */
export function historyStart(t: FileTarget): HistoryStart | null {
  if (t.wip) return t.wip.status === 'A' ? null : { path: t.wip.oldPath ?? t.path, rev: null, worktree: t.wip.worktree };
  return { path: t.deleted ? (t.diff.oldPath ?? t.path) : t.path, rev: t.sha };
}

/** The commit a row restores from, and whether it lacks the file (ruling 4). `null`: no Restore. */
export function restoreSource(t: FileTarget): { sha: string; absent: boolean } | null {
  if (t.wip) return null;
  if (t.diff.new.kind === 'atCommit') return { sha: t.diff.new.commit, absent: false };
  const spec = parseListSpec(t.diff.key);
  switch (spec?.kind) {
    case 'commit':
      return { sha: spec.id, absent: t.diff.new.kind === 'absent' };
    case 'compare':
      return { sha: spec.to, absent: t.diff.new.kind === 'absent' };
    case 'worktree':
      return t.diff.status === 'R' ? null : { sha: spec.from, absent: t.diff.old.kind === 'absent' };
    default:
      return null;
  }
}
