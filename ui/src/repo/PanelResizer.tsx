import { useRef } from 'react';

/** The drag handle between the center and right panels. Dragging left widens the panel. */
export function PanelResizer({ width, min, max, onChange }: { width: number; min: number; max: number; onChange: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.max(min, Math.min(max, Math.round(w)));
  const end = () => { drag.current = null; };
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
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection while dragging
        // Optional call: jsdom has no pointer capture.
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => { if (drag.current) onChange(clamp(drag.current.w - (e.clientX - drag.current.x))); }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onChange(clamp(width + 16));
        else if (e.key === 'ArrowRight') onChange(clamp(width - 16));
        else if (e.key === 'Home') onChange(min);
        else if (e.key === 'End') onChange(max);
        else return;
        e.preventDefault();
      }}
    />
  );
}
