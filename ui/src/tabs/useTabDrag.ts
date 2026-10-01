import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** Where a tab dragged from `from` lands when the pointer is at `x`: how many *other* tabs'
 * centres are left of it. */
export function dropIndex(mids: number[], from: number, x: number): number {
  return mids.filter((m, i) => i !== from && m < x).length;
}

const THRESHOLD = 4;

/**
 * Pointer-driven tab reordering (spec §6.2, no DnD library). Returns props for each tab and the
 * current drag (for rendering the dragged tab offset and the drop marker).
 */
export function useTabDrag(onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<{ from: number; to: number; dx: number } | null>(null);
  const start = useRef<{ from: number; x: number; mids: number[]; active: boolean } | null>(null);
  const justDragged = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, index: number) => {
    if (e.button !== 0) return;
    const strip = e.currentTarget.parentElement;
    const mids = strip
      ? [...strip.querySelectorAll<HTMLElement>('[role="tab"]')].map((el) => {
          const r = el.getBoundingClientRect();
          return r.left + r.width / 2;
        })
      : [];
    start.current = { from: index, x: e.clientX, mids, active: false };
    const move = (ev: PointerEvent) => {
      const s = start.current;
      if (!s) return;
      const dx = ev.clientX - s.x;
      if (!s.active && Math.abs(dx) < THRESHOLD) return;
      s.active = true;
      setDrag({ from: s.from, to: dropIndex(s.mids, s.from, s.mids[s.from] + dx), dx });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const s = start.current;
      start.current = null;
      setDrag(null);
      if (s?.active) {
        justDragged.current = true;
        const to = dropIndex(s.mids, s.from, s.mids[s.from] + (ev.clientX - s.x));
        if (to !== s.from) onMove(s.from, to);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** True once right after a drag ends: the click that follows must not activate the tab. */
  const consumeClick = () => {
    const was = justDragged.current;
    justDragged.current = false;
    return was;
  };

  return { drag, onPointerDown, consumeClick };
}
