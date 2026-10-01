import { useRef, type RefObject } from 'react';
import { onResetDoubleClick } from '../ui/resetHandle';

/**
 * The drag handle between the center and right panels. Dragging left widens the panel.
 *
 * While dragging, the live width is written straight to `panelRef`'s `style.width` — at most
 * once per animation frame, coalescing however many `pointermove` events land in between — so
 * the drag never fires a React commit of the rest of the view (the graph, the diff editor, the
 * details panel) per pointer event. `onChange` (which is `RepoLayout`'s `setState`, re-rendering
 * that tree) runs once, at the end of the gesture; a key press is a single discrete step, so it
 * goes straight through.
 */
export function PanelResizer({ width, min, max, defaultWidth = width, onChange, panelRef }: { width: number; defaultWidth?: number; min: number; max: number; onChange: (w: number) => void; panelRef: RefObject<HTMLElement | null> }) {
  const drag = useRef<{ x: number; live: number; raf: number | null } | null>(null);
  const clamp = (w: number) => Math.max(min, Math.min(max, Math.round(w)));
  const applyLive = (w: number) => {
    const el = panelRef.current;
    if (el) el.style.width = `${w}px`;
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.raf !== null) cancelAnimationFrame(d.raf);
    if (d.live !== width) onChange(d.live);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize details panel"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className="panel-resizer"
      {...onResetDoubleClick(() => { drag.current = null; onChange(clamp(defaultWidth)); })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection while dragging
        // Optional call: jsdom has no pointer capture.
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, live: width, raf: null };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.live = clamp(width - (e.clientX - d.x));
        if (d.raf === null) {
          d.raf = requestAnimationFrame(() => {
            if (drag.current) { drag.current.raf = null; applyLive(drag.current.live); }
          });
        }
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onChange(clamp(width + 16));
        else if (e.key === 'ArrowRight') onChange(clamp(width - 16));
        else if (e.key === 'Home') onChange(min);
        else if (e.key === 'End') onChange(max);
        else if (e.key === 'Enter') onChange(clamp(defaultWidth));
        else return;
        e.preventDefault();
      }}
    />
  );
}
