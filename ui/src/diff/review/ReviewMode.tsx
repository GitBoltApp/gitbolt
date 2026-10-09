import { lazy, Suspense } from 'react';
import { useRepoContext } from '../../app/repoContext';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import { forgeName, mrRef } from '../../forge/labels';
import { useReview, useReviewMrHead } from '../../forge/review/session';
import { useRepoView, type DiffTarget } from '../../repo/store';
import { reviewModeOf, type ReviewModeOf } from './mode';

/** Review mode's cards and gutter (`ActiveReview`), with the MR view's thread and composer: loaded
 * only once a review is on, so the diff panel's other users (File History, the merge tool) don't
 * take them in. `preloadReviewMode` starts the load when a review session begins. */
export const NOT_COMMENTABLE = "That line isn't in the merge request's diff: it takes no comment";
export const staleNote = (ref: string) => `${ref} has new commits since this compare: compare again to comment on them`;
/** The MR's head is the Compare's, but the forge's diff refs are still the last push's. */
export const updatingNote = (kind: ForgeKind, ref: string) => `${forgeName(kind)} is still updating ${ref}'s changes`;
/** Why a comment box can't send in a stale Compare (`reviewModeOf`); null while it can. */
export function blockedNote(mode: ReviewModeOf, kind: ForgeKind, number: number): string | null {
  if (!mode.on || !mode.stale) return null;
  const ref = mrRef(kind, number);
  return mode.updating ? updatingNote(kind, ref) : staleNote(ref);
}

export const preloadReviewMode = () => import('./ActiveReview');
const ActiveReview = lazy(() => preloadReviewMode().then((m) => ({ default: m.ActiveReview })));

/**
 * Review mode (spec 2026-10-08 §2), in a text diff's Source view: on while the open diff is the
 * tab's review session's Compare, for a file of the MR (`reviewModeOf`).
 */
export function ReviewMode({ target }: { target: DiffTarget }) {
  const { tabId } = useRepoContext();
  const review = useReview(tabId);
  const selection = useRepoView((s) => s.selection);
  const mode = reviewModeOf(review, selection, target, useReviewMrHead(tabId));
  return mode.on ? <Suspense fallback={null}><ActiveReview tabId={tabId} path={target.path} mode={mode} /></Suspense> : null;
}
