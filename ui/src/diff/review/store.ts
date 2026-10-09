import { create } from 'zustand';
import type { ReviewAnchor } from '../../api/gen/ReviewAnchor';
import { numberOf, sideOf } from '../../forge/review/model';

/**
 * Review mode's own UI state (spec 2026-10-08 §2), for the session: the comment boxes open under
 * lines, by anchor, in Source and Rendered alike (their text lives in the MR view's reply drafts, so it survives the box being laid out
 * again), and the threads the user folded or unfolded.
 */

/** A comment box under `anchor`'s lines; `suggestion`: the lines Suggest change puts in. */
export interface OpenBox { key: string; anchor: ReviewAnchor; suggestion?: string }

export const boxKey = (a: ReviewAnchor): string => `${a.path}:${sideOf(a.end)}:${a.start ? numberOf(a.start) : ''}-${numberOf(a.end)}`;
const mrKey = (tabId: string, number: number) => `${tabId}:${number}`;

export const useReviewUi = create<{ boxes: Record<string, OpenBox[]>; folds: Record<string, boolean> }>(() => ({ boxes: {}, folds: {} }));
export const NO_BOXES: readonly OpenBox[] = [];
export const boxesOf = (s: { boxes: Record<string, OpenBox[]> }, tabId: string, number: number): readonly OpenBox[] => s.boxes[mrKey(tabId, number)] ?? NO_BOXES;

/** Opens a box under `anchor` (the one already there, if any); its key. */
export function openBox(tabId: string, number: number, anchor: ReviewAnchor, suggestion?: string): string {
  const key = boxKey(anchor);
  useReviewUi.setState((s) => {
    const list = s.boxes[mrKey(tabId, number)] ?? [];
    if (list.some((b) => b.key === key)) return s;
    return { boxes: { ...s.boxes, [mrKey(tabId, number)]: [...list, { key, anchor, ...(suggestion !== undefined && { suggestion }) }] } };
  });
  return key;
}

export function closeBox(tabId: string, number: number, key: string): void {
  useReviewUi.setState((s) => ({ boxes: { ...s.boxes, [mrKey(tabId, number)]: (s.boxes[mrKey(tabId, number)] ?? []).filter((b) => b.key !== key) } }));
}

/** A thread card's fold, by tab, MR and thread. */
export const cardKey = (tabId: string, number: number, id: string): string => `${tabId}:${number}:${id}`;
export const setCardOpen = (key: string, open: boolean): void => useReviewUi.setState((s) => ({ folds: { ...s.folds, [key]: open } }));
