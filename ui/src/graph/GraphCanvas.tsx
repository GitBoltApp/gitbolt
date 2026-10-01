import { useLayoutEffect, useRef } from 'react';
import type { RowPayload } from '../api/gen/RowPayload';
import { useTheme } from '../theme/store';
import { drawGraph, graphLayout } from './draw';
import type { Metrics } from './geometry';
import { useDevicePixelRatio } from './pixels';

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
  /** More selected rows (a compare's or multi-selection's, K27), drawn the same. */
  alsoSelected?: ReadonlySet<number>;
  /** The checked-out branch's row, whose connector is a graph line (J21); -1 or omitted: none. */
  headRow?: number;
}

export function GraphCanvas({ rows, scrollTop, width, height, left, metrics, labeledRows, avatar, avatarVersion, clipped = false, scrollX = 0, id, selected = -1, alsoSelected, headRow = -1 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();
  // The theme's canvas colours: a new object on every theme or lane-override change, so the draw
  // effect reruns on a switch (it used to read --app-bg0 once and cache it).
  const colors = useTheme((s) => s.colors);

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
    drawGraph(ctx, { rows, first, last, scrollTop, width, height, metrics, colors: colors.graph, nodeFill: colors.nodeFill, nodeText: colors.nodeText, stripColor: colors.collapseStrip, labeledRows, dpr, avatar, clipped, scrollX, selected, alsoSelected, headRow });
  }, [rows, scrollTop, width, height, metrics, labeledRows, dpr, avatar, avatarVersion, clipped, scrollX, selected, alsoSelected, headRow, colors]);

  // `data-strip`: no lane fits, the column is a strip of nodes (F11); for tests and e2e.
  const strip = graphLayout(width, metrics, clipped || scrollX > 0).strip;
  // Sized to its backing store exactly (whole device px), so it's never resampled on screen: a
  // fraction of a pixel's stretch would blur its lines off the rows draw.ts snaps them to, and
  // off the DOM connectors they continue (K57).
  return <canvas ref={ref} id={id} className="graph-canvas" data-testid="graph-canvas" data-clipped={clipped} data-strip={strip} style={{ left, width: Math.round(width * dpr) / dpr, height: Math.round(height * dpr) / dpr }} />;
}
