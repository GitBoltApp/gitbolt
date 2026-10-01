/**
 * Scroll position that keeps `anchorId` at the same place on screen after the rows change
 * (a refresh after repo-changed/refs-updated, spec §4.4 "keeps the selection and scroll").
 * `rowH` is the density's row height (`useGraphMetrics().rowH`).
 */
export function anchoredScrollTop(oldRows: readonly { id: string }[], newRows: readonly { id: string }[], anchorId: string | null, scrollTop: number, rowH: number): number {
  if (!anchorId) return scrollTop;
  const before = oldRows.findIndex((r) => r.id === anchorId);
  const after = newRows.findIndex((r) => r.id === anchorId);
  if (before < 0 || after < 0) return scrollTop;
  return Math.max(0, scrollTop + (after - before) * rowH);
}
