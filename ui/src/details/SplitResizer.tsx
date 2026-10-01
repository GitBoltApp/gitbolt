import { useRef, type RefObject } from 'react';
import { SPLIT } from './detailsSplit';
import { onResetDoubleClick } from '../ui/resetHandle';

/**
 * The horizontal drag handle between the commit's header+message and its file list (feedback
 * F13), with the same patterns as `PanelResizer`: pointer capture, arrow keys, Home/End.
 * `ratio` is the top's share of the panel (already within `bounds`, `splitBounds` of the
 * measured panel `height`). Dragging down grows the top.
 *
 * While dragging, the live ratio is written straight to `targetRef`'s `flexBasis` — at most once
 * per animation frame, coalescing whatever `pointermove` events land in between — instead of
 * through React state: `onChange`'s setState would re-render the whole details panel, including
 * the (unrelated) file lists, on every pointer event. `onChange` and `onCommit` (persisting) both
 * run once, at the end of the gesture; a key press is a single discrete step, so it goes straight
 * through both.
 */
export function SplitResizer({ ratio, bounds, height, onChange, onCommit, targetRef, defaultRatio = SPLIT.default, label = 'Resize commit details', step = SPLIT.step }: {
  ratio: number;
  bounds: [number, number];
  height: number;
  onChange: (r: number) => void;
  onCommit: (r: number) => void;
  targetRef: RefObject<HTMLElement | null>;
  defaultRatio?: number;
  label?: string;
  step?: number;
}) {
  const drag = useRef<{ id: number; y: number; live: number; raf: number | null } | null>(null);
  const clamp = (r: number) => Math.max(bounds[0], Math.min(bounds[1], r));
  const applyLive = (r: number) => {
    const el = targetRef.current;
    if (el) el.style.flexBasis = `${r * 100}%`;
  };
  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.raf !== null) cancelAnimationFrame(d.raf);
    if (commit && d.live !== ratio) { onChange(d.live); onCommit(d.live); }
  };
  const key = (r: number) => {
    onChange(r);
    onCommit(r);
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(bounds[0] * 100)}
      aria-valuemax={Math.round(bounds[1] * 100)}
      tabIndex={0}
      className="split-resizer"
      {...onResetDoubleClick(() => { drag.current = null; key(clamp(defaultRatio)); })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection while dragging
        // Optional call: jsdom has no pointer capture.
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { id: e.pointerId, y: e.clientY, live: ratio, raf: null };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId || height <= 0) return;
        d.live = clamp(ratio + (e.clientY - d.y) / height);
        if (d.raf === null) {
          d.raf = requestAnimationFrame(() => {
            if (drag.current) { drag.current.raf = null; applyLive(drag.current.live); }
          });
        }
      }}
      onPointerUp={(e) => { if (drag.current?.id === e.pointerId) end(true); }}
      onPointerCancel={(e) => { if (drag.current?.id === e.pointerId) end(true); }}
      onLostPointerCapture={(e) => { if (drag.current?.id === e.pointerId) end(true); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') key(clamp(ratio + step));
        else if (e.key === 'ArrowUp') key(clamp(ratio - step));
        else if (e.key === 'Home') key(bounds[0]);
        else if (e.key === 'End') key(bounds[1]);
        else if (e.key === 'Enter') key(clamp(defaultRatio));
        else return;
        e.preventDefault();
      }}
    />
  );
}
