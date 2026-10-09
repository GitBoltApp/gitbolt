import { useMemo } from 'react';
import { api, errorMessage } from '../../api/client';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ReviewAnchor } from '../../api/gen/ReviewAnchor';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';
import type { ReviewSubmit } from '../../api/gen/ReviewSubmit';
import type { SubmitOutcome } from '../../api/gen/SubmitOutcome';
import { useRuntime } from '../../app/runtime';
import { forgeOf, knownMr, noteForgeWritten, patchForge, useForge, type ReviewSession } from '../mrStore';
import { refreshReview } from '../poll';
import { notifyForgeWrite } from '../usePolling';
import { compareShown, endReview, newSession, patchReview, settleReview, watchCompare } from './lifetime';
import { placeReview, type ReviewPlacements } from './model';

/**
 * The tab's review session (spec 2026-10-08 §1) and its writes (§6). A write that works updates
 * the session at once, then reads the forge back; one the forge refuses changes nothing and
 * returns the reason, so the comment box keeps its text and says why (§7). No toast: the box is
 * where the user is looking.
 */

export type ReviewWrite<T> = { ok: true; value: T } | { ok: false; error: string };

/** Starts (or, for the same MR, re-anchors) the tab's session on `compare`, and reads it. Another
 * MR's session gives way: its drafts stay on the forge, and its Compare finds them again. */
export function startReview(tabId: string, kind: ForgeKind, number: number, compare: { from: string; to: string }): Promise<void> {
  if (forgeOf(tabId).review?.number === number) patchReview(tabId, number, () => ({ compare }));
  else {
    endReview(tabId);
    patchForge(tabId, { review: newSession(kind, number, compare) });
  }
  watchCompare(tabId);
  return refreshReview(tabId);
}

const pendingIn = (s: { drafts: readonly unknown[]; pendingReview: string | null }): boolean => s.drafts.length > 0 || s.pendingReview !== null;

/**
 * A review left pending outside this session (before a restart, or on the forge's web page):
 * when the MR view opens MR `number` (once per open) or its Review… composer opens, and the tab's
 * session isn't that MR's, reads its drafts once. Any (GitLab's drafts, GitHub's pending review)
 * start a session for it without a Compare (alive while they last, `reviewAlive`), so the chip
 * shows and the composer sends them with the review. Another MR's session with its own drafts,
 * or whose Compare is shown, is left alone.
 */
export async function resumeReview(tabId: string, number: number): Promise<void> {
  const repo = useRuntime.getState().tabs[tabId]?.repo?.id;
  const kind = forgeOf(tabId).kind;
  const taken = () => {
    const cur = forgeOf(tabId).review;
    return !!cur && (cur.number === number || pendingIn(cur) || compareShown(tabId, cur));
  };
  if (repo === undefined || !kind || taken()) return;
  let state;
  try {
    state = await api.forgeReviewDrafts(repo, number);
  } catch {
    return; // The MR view's own reads say what's wrong with the forge.
  }
  if (!pendingIn(state) || taken() || forgeOf(tabId).kind !== kind) return;
  endReview(tabId);
  patchForge(tabId, { review: { ...newSession(kind, number, null), drafts: state.drafts, pendingReview: state.pendingReview, canDraft: state.canDraft, loaded: true } });
  watchCompare(tabId);
}

async function reviewWrite<T>(tabId: string, send: (repo: number, s: ReviewSession) => Promise<T>): Promise<ReviewWrite<T>> {
  const repo = useRuntime.getState().tabs[tabId]?.repo?.id;
  const s = forgeOf(tabId).review;
  if (repo === undefined || !s) return { ok: false, error: 'No review is open in this tab' };
  try {
    const value = await send(repo, s);
    noteForgeWritten(tabId); // a read under way may predate this answer
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

const NOT_LOADED = "The review's diff isn't loaded yet";

/** The MR the tab's session reviews, read before a write's await: its answer patches that
 * session only (another may have started meanwhile). -1: none. */
const reviewing = (tabId: string): number => forgeOf(tabId).review?.number ?? -1;

/** A write to MR `number`'s drafts went in: shows it at once, then reads the forge back, while
 * that MR's session is still the tab's. */
function patched(tabId: string, number: number, change: (s: ReviewSession) => Partial<ReviewSession>): void {
  if (reviewing(tabId) !== number) return;
  patchReview(tabId, number, change);
  void refreshReview(tabId);
}

export async function addToReview(tabId: string, anchor: ReviewAnchor, body: string): Promise<ReviewWrite<ReviewDraft>> {
  const s = forgeOf(tabId).review;
  if (!s?.refs) return { ok: false, error: NOT_LOADED };
  const refs = s.refs;
  const out = await reviewWrite(tabId, (repo) => api.forgeAddDraft(repo, s.number, { anchor, body, refs }));
  if (out.ok) patched(tabId, s.number, (cur) => ({ drafts: [...cur.drafts.filter((d) => d.id !== out.value.id), out.value] }));
  return out;
}

export async function commentNow(tabId: string, anchor: ReviewAnchor, body: string): Promise<ReviewWrite<ForgeDiscussion>> {
  const s = forgeOf(tabId).review;
  if (!s?.refs) return { ok: false, error: NOT_LOADED };
  const refs = s.refs;
  const out = await reviewWrite(tabId, (repo) => api.forgeCommentNow(repo, s.number, { anchor, body, refs }));
  if (out.ok) {
    patchForge(tabId, (f) => ({ discussions: { ...f.discussions, [s.number]: [...(f.discussions[s.number] ?? []), out.value] } }));
    notifyForgeWrite(tabId);
  }
  return out;
}

export async function editDraft(tabId: string, id: string, body: string): Promise<ReviewWrite<ReviewDraft>> {
  const n = reviewing(tabId);
  const out = await reviewWrite(tabId, (repo, s) => api.forgeEditDraft(repo, s.number, id, body));
  if (out.ok) patched(tabId, n, (cur) => ({ drafts: cur.drafts.map((d) => (d.id === id ? { ...d, body: out.value.body } : d)) }));
  return out;
}

export async function deleteDraft(tabId: string, id: string): Promise<ReviewWrite<null>> {
  const n = reviewing(tabId);
  const out = await reviewWrite(tabId, (repo, s) => api.forgeDeleteDraft(repo, s.number, id));
  if (out.ok) patched(tabId, n, (cur) => ({ drafts: cur.drafts.filter((d) => d.id !== id) }));
  return out;
}

/** Nothing pending on MR `number` any more: its session stays while its Compare is shown
 * (`settleReview`). A session since started on another MR is left alone. */
function cleared(tabId: string, number: number): void {
  patchReview(tabId, number, () => ({ drafts: [], pendingReview: null }));
  notifyForgeWrite(tabId);
  if (reviewing(tabId) === number) settleReview(tabId);
}

/** Sends the review with its drafts. A GitLab that published the drafts but refused the event
 * still answers `ok`, with `eventError` saying what didn't go through. */
export async function submitReview(tabId: string, review: ReviewSubmit): Promise<ReviewWrite<SubmitOutcome>> {
  const n = reviewing(tabId);
  const out = await reviewWrite(tabId, (repo, s) => api.forgeSubmitReview(repo, s.number, review));
  if (out.ok) cleared(tabId, n);
  return out;
}

export async function discardReview(tabId: string): Promise<ReviewWrite<number>> {
  const n = reviewing(tabId);
  const out = await reviewWrite(tabId, (repo, s) => api.forgeDiscardReview(repo, s.number));
  if (out.ok) cleared(tabId, n);
  return out;
}

export const useReview = (tabId: string): ReviewSession | null => useForge((s) => s.byTab[tabId]?.review ?? null);

/** The session's MR's head as the forge last said: its detail's, else the MR list's. */
export const useReviewMrHead = (tabId: string): string | null => useForge((st) => {
  const f = st.byTab[tabId];
  const n = f?.review?.number;
  return f && n !== undefined ? (f.details[n]?.value?.mr.headSha ?? knownMr(f, n)?.headSha ?? null) : null;
});

/** Where the session's MR's threads and drafts sit, per file (Plan 2's view zones, Plan 3's badges). */
export function useReviewPlacements(tabId: string): ReviewPlacements | null {
  const s = useReview(tabId);
  const threads = useForge((st) => (s ? st.byTab[tabId]?.discussions[s.number] : undefined));
  return useMemo(() => (s ? placeReview(s, threads ?? []) : null), [s, threads]);
}
