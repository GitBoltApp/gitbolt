import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { registerKeys } from '../ui/keyRouter';
import { shifts, targetIndex, type StripGeometry } from '../tabs/useTabDrag';

const geometry = (tops: number[], heights: number[]): StripGeometry => ({ lefts: tops, widths: heights, stripLeft: -Infinity, stripRight: Infinity });

/** The slot the dragged row lands in at offset `dy`. */
export const rowTarget = (tops: number[], heights: number[], from: number, dy: number): number => targetIndex(geometry(tops, heights), from, dy);

/** How far each row moves for that landing: the live insertion gap. */
export const rowShifts = (heights: number[], from: number, to: number): number[] => shifts(heights, from, to);

interface Drag { from: number; to: number; dy: number; heights: number[] }

/** Rows reordered by their handle (spec #3 §4.1, the tab drag of #2 UX round 2). `list`: the
 * `<ol>` whose `[data-irebase-row]` children are the rows. */
export function useRowDrag(list: React.RefObject<HTMLElement | null>, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const off = useRef<(() => void) | null>(null);
  useEffect(() => () => off.current?.(), []);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, index: number) => {
    if (e.button !== 0 || !list.current) return;
    e.preventDefault();
    const rects = [...list.current.querySelectorAll<HTMLElement>('[data-irebase-row]')].map((el) => el.getBoundingClientRect());
    const tops = rects.map((r) => r.top);
    const heights = rects.map((r) => r.height);
    const y0 = e.clientY;
    let active = false;
    let last = { to: index, dy: 0 };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      unkey();
      off.current = null;
      setDrag(null);
    };
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      if (!active && Math.abs(dy) < 4) return;
      active = true;
      last = { to: rowTarget(tops, heights, index, dy), dy };
      setDrag({ from: index, ...last, heights });
    };
    const up = () => {
      const to = last.to;
      stop();
      if (active && to !== index) onMove(index, to);
    };
    // The menu layer, above the editor's own keys (overlay): Esc puts the row back and nothing else.
    const unkey = registerKeys('menu', (ev) => {
      if (ev.key !== 'Escape' || !active) return;
      ev.preventDefault();
      stop();
      return 'handled';
    });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    off.current = stop;
  };
  const style = (i: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    if (i === drag.from) return { transform: `translateY(${drag.dy}px)`, zIndex: 1 };
    const s = rowShifts(drag.heights, drag.from, drag.to)[i];
    return s ? { transform: `translateY(${s}px)` } : undefined;
  };
  return { onPointerDown, style, dragging: drag !== null };
}
