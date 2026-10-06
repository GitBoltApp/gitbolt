import { tabStore } from '../app/tabStores';
import { recordPlace } from '../nav/history';
import { openCenterView } from '../repo/centerView';
import { useToast } from '../ui/toast';
import { writeCtx } from '../write/ctx';
import type { FileHistoryArgs } from './model';

/** The center view's kind (`history/feature.ts` registers it). */
export const FILE_HISTORY = 'fileHistory';

/** Where a file's history starts (ruling 1): `rev` null is `worktree`'s HEAD (absent: the tab's
 * active worktree). */
export interface HistoryStart { path: string; rev: string | null; worktree?: string }

/** Opens File History in tab `tabId`'s center panel, with Blame on or off (spec #3 §4.2). It's a
 * navigation place (spec #5 §3.4), and the tab's files follow it while it's open: its sticky mode
 * (`RepoViewState.stickyHistory`, UX). */
export function openFileHistory(tabId: string, start: HistoryStart, blame: boolean, opts: { follow?: boolean } = {}): boolean {
  const ctx = writeCtx(tabId, start.worktree);
  if (!ctx) {
    useToast.getState().show(`Couldn't open the history of ${start.path}: its repository's tab isn't ready`, { error: true });
    return false;
  }
  const args: FileHistoryArgs = { repoId: ctx.repoId, worktree: ctx.worktree, path: start.path, rev: start.rev, blame, ...(opts.follow ? { follow: true } : {}) };
  // Recorded first: the place being left keeps the mode it was in (its `capture`).
  recordPlace(tabId, { kind: 'history', path: args.path, rev: args.rev, worktree: args.worktree, blame });
  openCenterView(tabId, FILE_HISTORY, args);
  tabStore(tabId)?.getState().setStickyHistory({ blame });
  return true;
}

/** Whether File History open on `args` already shows `start`'s history. */
export const showsStart = (args: FileHistoryArgs, start: HistoryStart): boolean =>
  args.path === start.path && args.rev === start.rev && args.worktree === (start.worktree ?? args.worktree);
