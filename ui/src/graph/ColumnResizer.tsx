import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { COLUMN_MIN, columnMax, useColumnPrefs, type ColumnWidths, type ResizableColumn } from './columns';

/** Keyboard step, CSS px. */
export const RESIZE_STEP = 8;

interface Props {
  col: ResizableColumn;
  /** Accessible column name, e.g. "Branch / Tag". */
  name: string;
  /** Which edge of its header cell the handle sits on. Columns left of the flexing Message column
   * resize from their right edge ("end"); Author and Date, right of it, from their left edge
   * ("start"), so the boundary under the pointer is the one that moves either way. */
  edge: 'start' | 'end';
  /** The rendered widths (after the smart fit), which a drag or key press starts from. */
  cols: ColumnWidths;
  /** The scroll viewport's width, which the smart fit allocated `cols` for. */
  available: number;
}

/**
 * A column-boundary drag handle (`role="separator"`). Pointer drags and Left/Right keys move the
 * boundary (ArrowRight always moves it right); columns.ts `resizeColumn` decides what that does to
 * the widths. Every gesture goes beginResize → resizeBy… → endResize.
 */
export function ColumnResizer({ col, name, edge, cols, available }: Props) {
  const drag = useRef<{ pointerId: number; x: number } | null>(null);
  const width = cols[col];
  const store = () => useColumnPrefs.getState();

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    store().beginResize(col, cols, available);
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
    if (!dir) return;
    e.preventDefault();
    const s = store();
    s.beginResize(col, cols, available);
    s.resizeBy(dir * RESIZE_STEP);
    s.endResize();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${name} column`}
      aria-valuenow={width}
      aria-valuemin={COLUMN_MIN[col]}
      // The available width minus the other columns' minimums, but never below the current width
      // (a column widened before the window narrowed can be wider than that).
      aria-valuemax={Math.max(columnMax(col, available), width)}
      tabIndex={0}
      className={`col-resizer ${edge}`}
      data-testid={`resize-${col}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
    />
  );
}
