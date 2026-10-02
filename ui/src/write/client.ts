import type { GbError } from '../api/gen/GbError';
import type { WriteResult } from '../api/gen/WriteResult';
import { useRuntime } from '../app/runtime';
import { tabView } from '../app/tabStores';
import { toastActionError } from '../debug/errorToast';
import { toGbError } from '../errors/describe';
import { confirmAction, type ConfirmRequest } from '../ui/ConfirmDialog';
import { loadJournal, useJournal } from '../undo/store';
import { writeErrorContext } from './indexLock';

/** Where a write runs: the tab, its repo id and the worktree (canonical, as the backend says it). */
export interface WriteCtx { tabId: string; repoId: number; worktree: string }

/** The questions a write's request has had answered "yes" (each is asked at most once). */
export interface Confirmed {
  /** The clean-restore warning (§6.2): `confirmAutostash`. */
  autostash: boolean;
  /** "Apply without restoring what was staged?": `withoutIndex`. */
  withoutIndex: boolean;
}
const NONE: Confirmed = { autostash: false, withoutIndex: false };

/** Applies a write's answer (spec #2 §3.1): the journal and the fresh WIP lists at once, so the
 * UI never waits on the file watcher. */
export function applyResult(ctx: WriteCtx, r: WriteResult<unknown>): void {
  useJournal.getState().set(ctx.repoId, ctx.worktree, r.journal);
  if (r.wip) tabView(ctx.tabId)?.services.wip.put(r.wip.worktree, { staged: r.wip.staged, unstaged: r.wip.unstaged, version: r.wip.version });
}

/** The question a failure asks, answered by sending again with its flag set; `null`: not one. */
function question(err: GbError, asked: Confirmed): { req: ConfirmRequest; flag: keyof Confirmed } | null {
  const d = err.detail;
  if (d?.kind === 'autostashConflict' && !asked.autostash) {
    const [first, ...rest] = d.paths;
    const more = rest.length ? ` (and ${rest.length} more)` : '';
    return { flag: 'autostash', req: { title: 'Your changes conflict', body: `Your changes to ${first}${more} conflict with ${d.target}. They'll be kept in a stash you can apply afterwards.`, confirmLabel: 'Continue' } };
  }
  if (d?.kind === 'applyWithoutIndex' && !asked.withoutIndex) {
    return { flag: 'withoutIndex', req: { title: 'Apply without restoring what was staged?', body: 'git couldn\'t restore what was staged. Apply the changes unstaged instead?', confirmLabel: 'Apply' } };
  }
  return null;
}

/**
 * Sends one write (spec #2 §3.1: one request per operation; TypeScript only asks).
 * - `send(confirmed, asked)` makes the request: `confirmed` is true once any question was
 *   answered yes, and `asked` says which.
 * - The clean-restore warning (§6.2) and "Apply without restoring what was staged?" are asked
 *   here, and confirmed by sending again.
 * - Any other failure goes through the error toast (R12) with Retry, Refresh and, for a held
 *   index lock, Remove stale lock (`writeErrorContext`). A cancel says nothing.
 *
 * Resolves to the outcome, or `null` when it failed or the user said no.
 */
export async function runWrite<T>(ctx: WriteCtx, send: (confirmed: boolean, asked: Confirmed) => Promise<WriteResult<T>>, opts: { refresh?: () => void | Promise<void> } = {}): Promise<T | null> {
  const attempt = async (asked: Confirmed): Promise<T | null> => {
    try {
      const r = await send(asked.autostash || asked.withoutIndex, asked);
      applyResult(ctx, r as WriteResult<unknown>);
      return r.outcome;
    } catch (e) {
      const err = toGbError(e);
      const q = question(err, asked);
      if (q) return (await confirmAction(q.req)) ? attempt({ ...asked, [q.flag]: true }) : null;
      // A Stale undo, redo or banner (2A final M1) changed nothing, so no journalChanged comes:
      // reload it, so the toast's "Refreshed" is true and the toolbar names the real top.
      if (err.kind === 'Stale') await loadJournal(ctx.repoId, ctx.worktree);
      toastActionError(err, writeErrorContext(ctx.repoId, {
        retry: () => attempt(asked).then(() => {}),
        refresh: opts.refresh ?? (() => useRuntime.getState().refresh(ctx.tabId)),
      }));
      return null;
    }
  };
  return attempt(NONE);
}
