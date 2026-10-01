import { useLayoutEffect, useRef, useState } from 'react';
import type { RowPayload } from '../api/gen/RowPayload';
import { GRAPH_COLORS } from '../theme/graphColors';
import { drawGraph, graphLayout } from './draw';
import type { Metrics } from './geometry';

interface Props {
  rows: RowPayload[];
  scrollTop: number;
  width: number;
  height: number;
  left: number;
  metrics: Metrics;
  labeledRows: Set<number>;
  /** Loaded avatar bitmaps by author email, drawn in commit nodes. Keep it stable. */
  avatar?: (email: string) => ImageBitmap | null;
  /** Bumped when a new avatar arrives, to redraw with it. */
  avatarVersion?: number;
  /** The lanes need more width than the column has: the collapse zone and packed nodes (F2, F11). */
  clipped?: boolean;
  /** The lane scroll, CSS px (the Graph column's own scrollbar). */
  scrollX?: number;
  /** The canvas element's id (the lane scrollbar's `aria-controls`). */
  id?: string;
  /** The selected row, drawn with a brighter band (H14); -1 or omitted: none. */
  selected?: number;
  /** A second selected row (a compare's other side, K15), drawn the same; -1 or omitted: none. */
  alsoSelected?: number;
  /** The checked-out branch's row, whose connector is a graph line (J21); -1 or omitted: none. */
  headRow?: number;
}

export function GraphCanvas({ rows, scrollTop, width, height, left, metrics, labeledRows, avatar, avatarVersion, clipped = false, scrollX = 0, id, selected = -1, alsoSelected = -1, headRow = -1 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const nodeFillRef = useRef<string | undefined>(undefined);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);

  // Moving the window to a monitor with a different scale factor (or the OS changing zoom)
  // doesn't resize anything, so nothing else here would notice a stale backing-store size.
  // `matchMedia`'s query only matches at the dpr it was created with, so each firing re-arms
  // a fresh query at the new dpr rather than listening once.
  useLayoutEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [dpr]);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || height <= 0) return;
    const bw = Math.round(width * dpr), bh = Math.round(height * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const first = Math.max(0, Math.floor(scrollTop / metrics.rowH));
    const last = Math.min(rows.length, Math.ceil((scrollTop + height) / metrics.rowH) + 1);
    // `--app-bg0` doesn't change over a component's lifetime, so read it once and cache it
    // instead of calling getComputedStyle on every draw.
    if (nodeFillRef.current === undefined) {
      nodeFillRef.current = getComputedStyle(document.documentElement).getPropertyValue('--app-bg0').trim() || '#1c1e23';
    }
    drawGraph(ctx, { rows, first, last, scrollTop, width, height, metrics, colors: GRAPH_COLORS, nodeFill: nodeFillRef.current, labeledRows, dpr, avatar, clipped, scrollX, selected, alsoSelected, headRow });
  }, [rows, scrollTop, width, height, metrics, labeledRows, dpr, avatar, avatarVersion, clipped, scrollX, selected, alsoSelected, headRow]);

  // `data-strip`: no lane fits, the column is a strip of nodes (F11); for tests and e2e.
  const strip = graphLayout(width, metrics, clipped || scrollX > 0).strip;
  return <canvas ref={ref} id={id} className="graph-canvas" data-testid="graph-canvas" data-clipped={clipped} data-strip={strip} style={{ left, width, height }} />;
}
