import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { onResetDoubleClick } from '../ui/resetHandle';
import { handleRange, useColumnPrefs, type ColumnWidths, type ResizableColumn } from './columns';

/** Keyboard step, CSS px. */
export const RESIZE_STEP = 8;

interface Props {
  col: ResizableColumn;
  /** Accessible column name, e.g. "Branch / Tag". */
  name: string;
  /** The rendered widths (after the smart fit), which a drag or key press starts from. */
  cols: ColumnWidths;
  /** The scroll viewport's width, which the smart fit allocated `cols` for. */
  available: number;
  /** The widest the Graph column may get: every lane plus padding (F2). */
  graphMax?: number;
}

/**
 * A column's drag handle (`role="separator"`), on the RIGHT edge of the column it resizes (F3).
 * Pointer drags and Left/Right keys move that edge (ArrowRight always moves it right); columns.ts
 * `resizeColumn` decides what that does to the widths. Every gesture goes beginResize →
 * resizeBy… → endResize.
 */
export function ColumnResizer({ col, name, cols, available, graphMax }: Props) {
  const drag = useRef<{ pointerId: number; x: number } | null>(null);
  const width = cols[col];
  const range = handleRange(col, cols, available, graphMax);
  const store = () => useColumnPrefs.getState();

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    store().beginResize(col, cols, available, graphMax);
    drag.current = { pointerId: e.pointerId, x: e.clientX };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    store().resizeBy(e.clientX - d.x);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    store().endResize();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key === 'Enter') { e.preventDefault(); store().resetWidth(col); return; }
    if (!dir) return;
    e.preventDefault();
    const s = store();
    s.beginResize(col, cols, available, graphMax);
    s.resizeBy(dir * RESIZE_STEP);
    s.endResize();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${name} column`}
      aria-valuenow={width}
      aria-valuemin={range.min}
      aria-valuemax={Math.max(range.max, width)}
      tabIndex={0}
      className="col-resizer end"
      data-testid={`resize-${col}`}
      {...onResetDoubleClick(() => { drag.current = null; store().endResize(); store().resetWidth(col); })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
    />
  );
}
