import { useState } from 'react';
import { mrRef } from '../../forge/labels';
import { forgeOf, knownMr } from '../../forge/mrStore';
import { useReview } from '../../forge/review/session';
import type { ReviewModeOf } from './mode';
import { staleNote, updatingNote } from './ReviewMode';
import './review.css';

/**
 * Review mode's notes over a diff (spec 2026-10-08 §2, §7), in Source (`ActiveReview`) and in
 * Rendered (`RenderedReviewNote`): the Compare went stale, the forge is still catching up with a
 * push, it sent no diff for the file, or the MR's diff couldn't be read.
 */

/** The note for `mode`, if any: the same in both views. */
export function ReviewModeNote({ tabId, mode }: { tabId: string; mode: ReviewModeOf }) {
  const review = useReview(tabId);
  if (!mode.on || !review) return null;
  // Not stale yet: the refs will catch up (a later refresh), and review mode comes on by itself.
  if (mode.updating) return <div role="note" className="diff-banner review-banner">{updatingNote(review.kind, mrRef(review.kind, review.number))}</div>;
  if (mode.stale) return <StaleBanner tabId={tabId} />;
  if (mode.tooLarge) return <TooLargeNote />;
  // The MR's diff couldn't be read: no line takes a comment, and the gutter would just be missing.
  if (!mode.file && review.error !== null) return <div role="note" className="diff-banner review-banner">{readError(mrRef(review.kind, review.number), review.error)}</div>;
  return null;
}

export const readError = (ref: string, reason: string) => `Couldn't read ${ref}'s changes: ${reason}`;

export const TOO_LARGE = "The forge shows no diff for this file (it's too large): it takes no line comments";

export function TooLargeNote() {
  return <div role="note" className="diff-banner review-banner">{TOO_LARGE}</div>;
}

/** The MR's head moved past the Compare's: its lines aren't the forge's any more. */
export function StaleBanner({ tabId }: { tabId: string }) {
  const review = useReview(tabId);
  const [busy, setBusy] = useState(false);
  if (!review) return null;
  const again = async () => {
    const f = forgeOf(tabId);
    const mr = knownMr(f, review.number);
    if (!mr || busy) return;
    setBusy(true);
    // Compare's code: with the MR view's, not with every diff's.
    const { compareMr } = await import('../../forge/mrview/compare');
    await compareMr(tabId, review.kind, mr, f.details[review.number]?.value ?? null);
    setBusy(false);
  };
  return (
    <div role="note" className="diff-banner review-banner">
      <span>{staleNote(mrRef(review.kind, review.number))}</span>
      <button type="button" className="text-button" aria-busy={busy || undefined} onClick={() => void again()}>Compare again</button>
    </div>
  );
}
