import { useLayoutEffect, useRef } from 'react';

/** The lane scrollbar's height: the app's 10 px scrollbar lane (theme/tokens.css). */
export const HSCROLL_H = 10;

/**
 * The Graph column's own horizontal scrollbar, for lanes wider than the column (spec §8.3):
 * across the lane area at the column's bottom (the collapse zone keeps its packed column). A
 * native scroller over an empty `contentW`-wide child, so it looks and behaves like every other
 * scrollbar. Controlled: `scrollX` is written back to it, so a remount (the lanes fit again, then
 * don't) or a clamp (the column widened) shows the offset actually drawn.
 */
export function HScroll({ left, top, width, contentW, scrollX, onScroll, controls }: { left: number; top: number; width: number; contentW: number; scrollX: number; onScroll(x: number): void; /** The canvas's id. */ controls: string }) {
  const max = Math.max(0, contentW - width);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.scrollLeft !== scrollX) el.scrollLeft = scrollX;
  }, [scrollX, width, contentW]);
  return (
    // A scrollbar for assistive tech (value: the lane offset in CSS px). It controls the graph's
    // canvas, which draws the lanes at that offset.
    <div
      ref={ref}
      className="graph-hscroll"
      style={{ left, top, width, height: HSCROLL_H }}
      role="scrollbar"
      aria-label="Scroll lanes"
      aria-orientation="horizontal"
      aria-controls={controls}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(Math.min(scrollX, max))}
      onScroll={(e) => onScroll(e.currentTarget.scrollLeft)}
    >
      <div style={{ width: contentW, height: 1 }} />
    </div>
  );
}
