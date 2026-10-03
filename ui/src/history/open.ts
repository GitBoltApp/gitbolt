import { openCenterView } from '../repo/centerView';
import { useToast } from '../ui/toast';
import { writeCtx } from '../write/ctx';
import type { FileHistoryArgs } from './model';

/** The center view's kind (`history/feature.ts` registers it). */
export const FILE_HISTORY = 'fileHistory';

/** Where a file's history starts (ruling 1): `rev` null is `worktree`'s HEAD (absent: the tab's
 * active worktree). */
export interface HistoryStart { path: string; rev: string | null; worktree?: string }

/** Opens File History in tab `tabId`'s center panel, with Blame on or off (spec #3 §4.2). */
export function openFileHistory(tabId: string, start: HistoryStart, blame: boolean): boolean {
  const ctx = writeCtx(tabId, start.worktree);
  if (!ctx) {
    useToast.getState().show(`Couldn't open the history of ${start.path}: its repository's tab isn't ready`, { error: true });
    return false;
  }
  const args: FileHistoryArgs = { repoId: ctx.repoId, worktree: ctx.worktree, path: start.path, rev: start.rev, blame };
  openCenterView(tabId, FILE_HISTORY, args);
  return true;
}
