import { useRef } from 'react';
import { onResetDoubleClick } from '../ui/resetHandle';
import { MIN_PANEL_H, resizePair } from './layout';

const STEP = 24;

/**
 * The draggable divider at the bottom of an expanded panel: it trades height with the next
 * expanded panel below it. Same pattern as the panel resizers in `repo/` (K26): while dragging,
 * the two panels' heights are written straight to their elements, at most once per animation
 * frame, so the drag never re-renders the sidebar per pointer event; `onCommit` (which persists
 * and re-renders) runs once at the end. A key press is one discrete step, so it commits at once.
 */
export function PanelDivider({ label, upperH, lowerH, getEls, onCommit, onReset }: {
  label: string;
  upperH: number;
  lowerH: number;
  getEls: () => [HTMLElement | null, HTMLElement | null];
  onCommit: (upper: number, lower: number) => void;
  /** Double-click / Enter: back to the default layout (no saved heights). */
  onReset: () => void;
}) {
  const drag = useRef<{ y: number; live: [number, number]; raf: number | null } | null>(null);
  const apply = (h: [number, number]) => {
    const [a, b] = getEls();
    if (a) a.style.height = `${h[0]}px`;
    if (b) b.style.height = `${h[1]}px`;
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.raf !== null) cancelAnimationFrame(d.raf);
    apply(d.live);
    if (d.live[0] !== upperH) onCommit(d.live[0], d.live[1]);
  };
  const step = (delta: number) => {
    const [u, l] = resizePair(upperH, lowerH, delta);
    if (u !== upperH) onCommit(u, l);
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={upperH}
      aria-valuemin={MIN_PANEL_H}
      aria-valuemax={upperH + lowerH - MIN_PANEL_H}
      tabIndex={0}
      className="sb-divider"
      {...onResetDoubleClick(() => { drag.current = null; onReset(); })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { y: e.clientY, live: [upperH, lowerH], raf: null };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.live = resizePair(upperH, lowerH, e.clientY - d.y);
        if (d.raf === null) {
          d.raf = requestAnimationFrame(() => {
            if (drag.current) { drag.current.raf = null; apply(drag.current.live); }
          });
        }
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') step(-STEP);
        else if (e.key === 'ArrowDown') step(STEP);
        else if (e.key === 'Enter') onReset();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}
