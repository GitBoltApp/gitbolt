import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The graph's one row-dim mechanism: which rows have their TEXT cells (message, author, date,
 * SHA) dimmed, and at which of two levels (`DimKind`). The graph
 * canvas, the chips and the rows' hover and selection backgrounds are never touched.
 *
 * The seam, for every source of dimming:
 * - A source builds a `RowDim` (a predicate over row indexes; `dimAllBut(kept, kind)` for
 *   "everything but these rows, at this level") or `null` for none.
 * - GraphView evaluates it per rendered row and hands each row a plain `DimKind | false`
 *   (`dimmed`), so its memoized rows re-render only when their own dim state changes, never for a
 *   new predicate that dims the same rows at the same level.
 * - The row puts `ROW_DIM_CLASS` plus a kind class (`rowDimKindClass(kind)`) on its text cells;
 *   graph.css eases them all at the shared motion tokens (`--motion-row-color` /
 *   `--motion-row-dim`, theme/tokens.css) but colours each kind differently.
 *
 * Sources, and their level:
 * - `'branch'`: J22's branch-hover focus, inside GraphView (`useBranchFocus` below): hovering a
 *   branch chip for `BRANCH_FOCUS_DELAY_MS` dims every row not in that branch (`branchRows`,
 *   membership.ts), at `--text-row-dimmed-branch` (50% white).
 * - `'filter'`: Plan 1C Task 17's Ctrl+F commit search: `GraphView`'s `rowDim` prop
 *   (`dimAllBut(matchingRows, 'filter')`, which RepoView builds from the store's `filterKeep`).
 *   Dims at `--text-row-dimmed` (20% white).
 *
 * When both are active (`strongerDim`), each row takes the stronger of its two levels: a row
 * Find dims stays at 'filter' (20%) whatever the hover says, and the hover dims Find's matches
 * outside the hovered branch at 'branch' (50%). So hovering a chip during a search still shows
 * which matches are on that branch, and a non-match never looks brighter than a match.
 */
export type DimKind = 'branch' | 'filter';

export interface RowDim {
  dimmed(index: number): DimKind | false;
}

/** Dims every row except `kept`, at `kind`'s level. */
export function dimAllBut(kept: ReadonlySet<number>, kind: DimKind): RowDim {
  return { dimmed: (i) => !kept.has(i) && kind };
}

/** The stronger dim level of `a` and `b` (`'filter'` over `'branch'` over none). */
const LEVEL: Record<DimKind, number> = { branch: 1, filter: 2 };
function stronger(a: DimKind | false, b: DimKind | false): DimKind | false {
  if (!a) return b;
  if (!b) return a;
  return LEVEL[a] >= LEVEL[b] ? a : b;
}

/** Both sources at once: each row at the stronger of its two levels (either may be `null`). */
export function strongerDim(a: RowDim | null, b: RowDim | null): RowDim | null {
  if (!a || !b) return a ?? b;
  return { dimmed: (i) => stronger(a.dimmed(i), b.dimmed(i)) };
}

/** The class every dimmed row's text cells carry, whatever the level (the shared motion rule,
 * graph.css). */
export const ROW_DIM_CLASS = 'row-dim';

/** The extra, level-specific class (graph.css: colours `--text-row-dimmed-branch` or
 * `--text-row-dimmed`). */
export function rowDimKindClass(kind: DimKind): string {
  return `${ROW_DIM_CLASS}-${kind}`;
}

/** How long the pointer must rest on a branch chip before its branch is focused (J22). */
export const BRANCH_FOCUS_DELAY_MS = 500;

/**
 * J22's branch-hover focus: `onBranchHover(refs)` when the pointer enters a branch chip (the
 * refs it stands for, `chipRefs`), `onBranchHover(null)` when it leaves. `refs` is the focused
 * branch once the pointer has rested `BRANCH_FOCUS_DELAY_MS` on the same chip; leaving clears it
 * at once (and cancels a pending focus). `onBranchHover` is stable.
 */
export function useBranchFocus(delayMs = BRANCH_FOCUS_DELAY_MS): { refs: readonly string[] | null; onBranchHover(refs: readonly string[] | null): void } {
  const [refs, setRefs] = useState<readonly string[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onBranchHover = useCallback((next: readonly string[] | null) => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (!next || next.length === 0) {
      setRefs(null);
      return;
    }
    timer.current = setTimeout(() => setRefs(next), delayMs);
  }, [delayMs]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { refs, onBranchHover };
}
