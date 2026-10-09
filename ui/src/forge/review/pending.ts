import type { ForgeKind } from '../../api/gen/ForgeKind';
import { currentOrigin } from '../../ui/arm/origin';
import { confirmAction } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/toastStore';
import { mrRef } from '../labels';
import type { ReviewSession } from '../mrStore';
import { discardReview } from './session';

/** A review is pending in the session (spec 2026-10-08 §4): drafts, or GitHub's pending review. */
export const isPending = (s: ReviewSession | null): s is ReviewSession => !!s && (s.drafts.length > 0 || s.pendingReview !== null);

/** "3 pending", or "review pending" (GitHub's pending review with no comment yet): the top bar's
 * chip and the MR view's pill say the same. */
export const pendingLabel = (s: ReviewSession): string => (s.drafts.length > 0 ? `${s.drafts.length} pending` : 'review pending');

/** What's pending, for the confirm and the toast. */
export const pendingText = (n: number): string => (n === 0 ? 'your pending review' : n === 1 ? '1 pending comment' : `${n} pending comments`);

/** Discard the pending review: the control arms in place first (the chip's menu row, the MR
 * view's Discard), then the forge deletes it; a toast says what went. */
export async function discardPending(tabId: string, kind: ForgeKind, s: ReviewSession, origin = currentOrigin()): Promise<void> {
  const what = pendingText(s.drafts.length);
  const ref = mrRef(kind, s.number);
  if (!(await confirmAction({ title: `Discard ${what} on ${ref}?`, arm: `Click again to discard ${what}`, confirmLabel: 'Discard', danger: true }, origin))) return;
  const out = await discardReview(tabId);
  if (out.ok) useToast.getState().show(`Discarded ${what} on ${ref}`);
  else useToast.getState().show(`Couldn't discard the review: ${out.error}`, { error: true });
}
