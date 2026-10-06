import { memo, useImperativeHandle, useLayoutEffect, useRef, type Ref, type RefObject } from 'react';
import type { RowPayload } from '../api/gen/RowPayload';
import { useTheme } from '../theme/store';
import { bandAt, bandCovers, bandOverscan, type Band } from './band';
import { drawGraph, graphLayout } from './draw';
import type { Metrics } from './geometry';
import { useDevicePixelRatio } from './pixels';

declare global {
  /** Test builds only: set to `[]` and each drawGraph's duration (ms) is pushed onto it (the
   * graph scroll perf probe, e2e/graph-scroll-perf.spec.ts). */
  interface Window { __gbGraphDraws?: number[] }
}
const PROBE = import.meta.env.DEV || import.meta.env.MODE === 'e2e';

/** GraphView's handle: `sync()` on every scroll event (they come once per frame, before it
 * paints, so a band redraw lands in the frame whose scroll needed it; only a comparison while
 * the band still covers the viewport), and right after it sets the scroll offset itself (a
 * refresh's anchor, a density change, the restore after <Activity>, a keyboard move). */
export interface GraphCanvasHandle { sync(): void }

interface Props {
  rows: RowPayload[];
  /** The scroll container the canvas sits in (inside its scrolled content): `sync()` reads its
   * offset. Omitted: the band stays at the top (tests). */
  scroller?: RefObject<HTMLElement | null>;
  width: number;
  /** The scroll viewport's height (its clientHeight). */
  height: number;
  /** The canvas's x in the scrolled content: the Branch/Tag column's width. */
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
  ref?: Ref<GraphCanvasHandle>;
}

/** What the scroll listener needs between renders: the drawn band, and how to draw another. */
interface Live {
  band: Band | null;
  height: number;
  rowH: number;
  dpr: number;
  paint: ((band: Band) => void) | null;
}

/**
 * The graph's lines, nodes, row bands and the canvas half of the label connectors. It sits in the
 * scrolled content (band.ts): the compositor scrolls it with the rows, so it can't fall behind
 * them. It holds a band of the content (the viewport and up to one more viewport above and below)
 * and is redrawn imperatively (`sync()`, from GraphView's scroll handler) only when the viewport
 * nears the band's edge: no React render moves it. Props redraw it in a layout effect.
 */
export const GraphCanvas = memo(function GraphCanvas({ rows, scroller, width, height, left, metrics, labeledRows, avatar, avatarVersion, clipped = false, scrollX = 0, id, selected = -1, alsoSelected, headRow = -1, ref }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();
  // The theme's canvas colours: a new object on every theme or lane-override change, so the draw
  // effect reruns on a switch (it used to read --app-bg0 once and cache it).
  const colors = useTheme((s) => s.colors);
  const live = useRef<Live>({ band: null, height: 0, rowH: metrics.rowH, dpr, paint: null });
  const bandH = height + 2 * bandOverscan(height, metrics.rowH, dpr);

  useImperativeHandle(ref, () => ({ sync: () => syncBand(live.current, scroller, false) }), [scroller]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || height <= 0) return;
    const l = live.current;
    // A new geometry: the drawn band's rows and device grid no longer hold.
    if (l.height !== height || l.rowH !== metrics.rowH || l.dpr !== dpr) l.band = null;
    l.height = height;
    l.rowH = metrics.rowH;
    l.dpr = dpr;
    l.paint = (band) => {
      // Sized to its backing store exactly (whole device px), so it's never resampled on screen:
      // a fraction of a pixel's stretch would blur its lines off the rows draw.ts snaps them to,
      // and off the DOM connectors they continue (K57). The band's top is on the device grid.
      const bw = Math.round(width * dpr), bh = Math.round(band.height * dpr);
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      canvas.style.top = `${band.top}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const first = Math.max(0, Math.floor(band.top / metrics.rowH));
      const last = Math.min(rows.length, Math.ceil((band.top + band.height) / metrics.rowH) + 1);
      const t0 = PROBE ? performance.now() : 0;
      // `scrollTop` is the content y at the canvas's top edge: the band's.
      drawGraph(ctx, { rows, first, last, scrollTop: band.top, width, height: band.height, metrics, colors: colors.graph, nodeFill: colors.nodeFill, avatarBackdrop: colors.avatarBackdrop, laneText: colors.laneText, nodeText: colors.nodeText, stripColor: colors.collapseStrip, labeledRows, dpr, avatar, clipped, scrollX, selected, alsoSelected, headRow });
      if (PROBE) window.__gbGraphDraws?.push(performance.now() - t0);
    };
    syncBand(l, scroller, true);
  }, [rows, width, height, metrics, labeledRows, dpr, avatar, avatarVersion, clipped, scrollX, selected, alsoSelected, headRow, colors, scroller]);

  // `data-strip`: no lane fits, the column is a strip of nodes (F11); for tests and e2e.
  const strip = graphLayout(width, metrics, clipped || scrollX > 0).strip;
  // `top` is the band's, set where it's drawn (never by React, so a re-render can't move it).
  return <canvas ref={canvasRef} id={id} className="graph-canvas" data-testid="graph-canvas" data-clipped={clipped} data-strip={strip} style={{ left, width: Math.round(width * dpr) / dpr, height: Math.round(bandH * dpr) / dpr }} />;
});

/** Keeps the drawn band while it still covers the viewport, unless `force` (the drawing itself
 * changed: it's redrawn, in place); otherwise draws a fresh band around the viewport. */
function syncBand(l: Live, scroller: RefObject<HTMLElement | null> | undefined, force: boolean): void {
  if (!l.paint || l.height <= 0) return;
  const top = scroller?.current?.scrollTop ?? 0;
  const b = l.band;
  const keep = b !== null && bandCovers(b, top, l.height);
  if (keep && !force) return;
  l.band = keep ? b : bandAt(top, l.height, l.rowH, l.dpr);
  l.paint(l.band);
}
