import type { GbError } from '../api/gen/GbError';
import type { WriteResult } from '../api/gen/WriteResult';
import { useRuntime } from '../app/runtime';
import { tabView } from '../app/tabStores';
import { toastActionError } from '../debug/errorToast';
import { toGbError } from '../errors/describe';
import { ERROR_TOAST_MS, useToast } from '../ui/toast';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { confirmAction, type ConfirmRequest } from '../ui/ConfirmDialog';
import { useStaging } from '../stage/store';
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
  // --- 2C T9: the reset question ---
  /** "Reset main to a1b2c3 and discard changes to 4 files?" (spec #2 §9.4): `discard`. */
  discard: boolean;
  // --- end 2C T9 ---
  // --- 2D T15 ---
  /** "Mark it resolved anyway?" (spec #2 §13.3): `confirmMarkers`. */
  markers: boolean;
  // --- end 2D T15 ---
}
const NONE: Confirmed = { autostash: false, withoutIndex: false, discard: false, markers: false };

/** Applies a write's answer (spec #2 §3.1): the journal and the fresh WIP lists at once, so the
 * UI never waits on the file watcher. */
export function applyResult(ctx: WriteCtx, r: WriteResult<unknown>): void {
  useJournal.getState().set(ctx.repoId, ctx.worktree, r.journal);
  useStaging.getState().set(ctx.repoId, ctx.worktree, r.staging);
  if (r.wip) tabView(ctx.tabId)?.services.wip.put(r.wip.worktree, { staged: r.wip.staged, unstaged: r.wip.unstaged, version: r.wip.version });
}

/** The question a failure asks, answered by sending again with its flag set; `null`: not one. */
function question(err: GbError, asked: Confirmed): { req: ConfirmRequest; flag: keyof Confirmed } | null {
  const d = err.detail;
  if (d?.kind === 'autostashConflict' && !asked.autostash) {
    const [first, ...rest] = d.paths;
    const more = rest.length ? ` (and ${rest.length} more)` : '';
    const body = `Your changes to ${first}${more} conflict with ${d.target}. They'll be kept in a stash you can apply afterwards.`;
    return { flag: 'autostash', req: { title: 'Your changes conflict', body, confirmLabel: 'Continue', arm: 'Click again to continue: your changes go to a stash', caption: body, tone: 'warn' } };
  }
  if (d?.kind === 'applyWithoutIndex' && !asked.withoutIndex) {
    return { flag: 'withoutIndex', req: { title: 'Apply without restoring what was staged?', body: 'git couldn\'t restore what was staged. Apply the changes unstaged instead?', confirmLabel: 'Apply', arm: 'Click again to apply it all unstaged', caption: 'git couldn\'t restore what was staged.', tone: 'warn' } };
  }
  // --- 2C T9: the reset question ---
  if (d?.kind === 'resetDiscards' && !asked.discard) {
    const n = d.files;
    return { flag: 'discard', req: { title: 'Discard changes?', body: err.message, confirmLabel: 'Reset', arm: `Click again to reset ${d.branch} and discard changes to ${n} ${n === 1 ? 'file' : 'files'}`, caption: err.message, danger: true } };
  }
  // --- end 2C T9 ---
  // --- 2D T15 ---
  if (d?.kind === 'markersRemain' && !asked.markers) {
    return { flag: 'markers', req: { title: 'Conflict markers remain', body: `${d.path} still has conflict markers. Mark it resolved anyway?`, confirmLabel: 'Mark resolved', arm: 'Click again to mark it resolved with its conflict markers', caption: `${d.path} still has conflict markers.`, tone: 'warn' } };
  }
  // Take current / Take incoming over the user's edits: `confirmDiscard`, sent with the
  // destructive `discard` flag (a Retry never re-sends it).
  if (d?.kind === 'discardEdits' && !asked.discard) {
    return { flag: 'discard', req: { title: 'Discard your edits?', body: `Discard your edits to ${d.path}? The side you chose replaces the file, and Undo can't bring the edits back.`, confirmLabel: 'Discard edits', arm: `Click again to replace your edits to ${d.path}`, caption: "Undo can't bring the edits back.", danger: true } };
  }
  // --- end 2D T15 ---
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
export async function runWrite<T>(ctx: WriteCtx, send: (confirmed: boolean, asked: Confirmed) => Promise<WriteResult<T>>, opts: { refresh?: () => void | Promise<void>; onSuccess?: (outcome: T) => void | Promise<void>; handle?: (err: GbError) => boolean; origin?: Origin | null } = {}): Promise<T | null> {
  // Where the write started (spec §ui confirms): its questions arm that control, after the answer.
  // A caller that awaited before writing passes the origin it captured (`null`: a popover).
  const origin = 'origin' in opts ? opts.origin ?? null : currentOrigin();
  const attempt = async (asked: Confirmed): Promise<T | null> => {
    let outcome: T;
    try {
      const r = await send(asked.autostash || asked.withoutIndex || asked.discard || asked.markers, asked);
      applyResult(ctx, r as WriteResult<unknown>);
      outcome = r.outcome;
    } catch (e) {
      const err = toGbError(e);
      const q = question(err, asked);
      if (q) return (await confirmAction(q.req, origin)) ? attempt({ ...asked, [q.flag]: true }) : null;
      // A Stale undo, redo or banner (2A final M1) changed nothing, so no journalChanged comes:
      // reload it, so the toast's "Refreshed" is true and the toolbar names the real top.
      if (err.kind === 'Stale') await loadJournal(ctx.repoId, ctx.worktree);
      // --- 2C T9: caller-handled failures ---
      // A caller that has its own answer for this failure (CheckedOutElsewhere's [Switch to it]).
      try {
        if (opts.handle?.(err)) return null;
      } catch (he) {
        console.error('[gitbolt] a write failure handler threw', he);
        useToast.getState().show(`Couldn't handle the failure: ${toGbError(he).message}`, { ms: ERROR_TOAST_MS });
        return null;
      }
      // --- end 2C T9 ---
      toastActionError(err, writeErrorContext(ctx.repoId, {
        // A retry never re-sends a destructive discard the user confirmed for an earlier attempt.
        retry: () => attempt({ ...asked, discard: false }).then(() => {}),
        refresh: opts.refresh ?? (() => useRuntime.getState().refresh(ctx.tabId)),
      }));
      return null;
    }
    // The write succeeded. Every success path, a Retry from the error toast included, runs the
    // caller's follow-up here; if that throws, the write still stands: log it, no Retry.
    try {
      await opts.onSuccess?.(outcome);
    } catch (e) {
      console.error('[gitbolt] follow-up after a write failed', e);
      useToast.getState().show(`Done, but the view didn't update: ${toGbError(e).message}`, { ms: ERROR_TOAST_MS });
    }
    return outcome;
  };
  return attempt(NONE);
}
