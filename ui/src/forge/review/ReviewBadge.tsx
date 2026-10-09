import { MessageSquare } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import type { DiffSpec } from '../../api/gen/DiffSpec';
import type { FileRow } from '../../files/fileTree';
import { useRepoViewStore } from '../../repo/store';
import { badgeLabel, fileBadge, nextStop, placementLine, type FileBadge } from './badges';
import { compareStale } from './model';
import { useReview, useReviewPlacements } from './session';
import './review.css';

/** A file row's review badge: a bubble and a count, highlighted while a thread on the file is
 * unresolved. Not a tab stop (the rows are a listbox): from the keyboard, open the file and step
 * through its threads with the thread keys. */
export function ReviewBadge({ badge, onOpen }: { badge: FileBadge; onOpen: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className="review-badge"
      data-unresolved={badge.unresolved > 0 || undefined}
      aria-label={badgeLabel(badge)}
      // The row's own press opens the file at its first change: this one at its next thread (`nextStop`).
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
    >
      <MessageSquare size={11} aria-hidden />{badge.count}
    </button>
  );
}

/** The file list's badges (spec 2026-10-08 §5) for a section showing the tab's review Compare:
 * its `renderActions`. Undefined for any other section, and while the Compare is stale. */
export function useReviewRowBadge(tabId: string, spec: DiffSpec): ((row: FileRow) => ReactNode) | undefined {
  const s = useReview(tabId);
  const placed = useReviewPlacements(tabId);
  const store = useRepoViewStore();
  // A stale Compare (the MR moved on, or the forge is still catching up with a push) shows none of
  // the forge's cards in either view: no badges for them either.
  const number = s?.number ?? -1;
  const on = !!s?.compare && spec.kind === 'compare' && spec.from === s.compare.from && spec.to === s.compare.to && !compareStale(s);
  return useMemo(() => {
    if (!on || !placed) return undefined;
    return (row: FileRow) => {
      if (row.kind !== 'file') return null;
      const b = fileBadge(placed.byPath[row.target.path]);
      return b && <ReviewBadge badge={b} onOpen={() => store.getState().openFile({ ...row.target, view: 'diff', line: placementLine(nextStop(`${tabId}:${number}:${row.target.path}`, b)) })} />;
    };
  }, [on, placed, store, tabId, number]);
}
