import { useRef } from 'react';
import { SPLIT } from './detailsSplit';

/**
 * The horizontal drag handle between the commit's header+message and its file list (feedback
 * F13), with the same patterns as `PanelResizer`: pointer capture, arrow keys, Home/End.
 * `ratio` is the top's share of the panel (already within `bounds`, `splitBounds` of the
 * measured panel `height`). Dragging down grows the top. `onChange` follows every move;
 * `onCommit` gets the final ratio (on pointer up, and on each key) for persisting.
 */
export function SplitResizer({ ratio, bounds, height, onChange, onCommit }: {
  ratio: number;
  bounds: [number, number];
  height: number;
  onChange: (r: number) => void;
  onCommit: (r: number) => void;
}) {
  const drag = useRef<{ id: number; y: number; r: number; last: number } | null>(null);
  const clamp = (r: number) => Math.max(bounds[0], Math.min(bounds[1], r));
  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (commit && d && d.last !== d.r) onCommit(d.last);
  };
  const key = (r: number) => {
    onChange(r);
    onCommit(r);
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize commit details"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(bounds[0] * 100)}
      aria-valuemax={Math.round(bounds[1] * 100)}
      tabIndex={0}
      className="split-resizer"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection while dragging
        // Optional call: jsdom has no pointer capture.
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { id: e.pointerId, y: e.clientY, r: ratio, last: ratio };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId || height <= 0) return;
        d.last = clamp(d.r + (e.clientY - d.y) / height);
        onChange(d.last);
      }}
      onPointerUp={(e) => { if (drag.current?.id === e.pointerId) end(true); }}
      onPointerCancel={(e) => { if (drag.current?.id === e.pointerId) end(true); }}
      onLostPointerCapture={(e) => { if (drag.current?.id === e.pointerId) end(true); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') key(clamp(ratio + SPLIT.step));
        else if (e.key === 'ArrowUp') key(clamp(ratio - SPLIT.step));
        else if (e.key === 'Home') key(bounds[0]);
        else if (e.key === 'End') key(bounds[1]);
        else return;
        e.preventDefault();
      }}
    />
  );
}
