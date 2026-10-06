import { snapScroll } from './pixels';

/**
 * The graph canvas's band: the strip of scrolled content it holds drawn. The canvas sits inside
 * the scrolled content (GraphView), so the compositor moves it with the rows in the same frame,
 * whatever the main thread is doing: it can never lag them. It holds more than the viewport (an
 * overscan above and below), and is redrawn (re-centred on the viewport) only when the viewport
 * comes within half that overscan of one of its edges. A late redraw then shows, at worst, as
 * the band's edge at the viewport's top or bottom during a very fast fling, never as the graph
 * misaligned with its rows.
 *
 * All values are CSS px in content coordinates (0 is the first row's top).
 */
export interface Band {
  /** The content y at the canvas's top edge: on a row boundary, less the overscan (and on the
   * device pixel grid). */
  top: number;
  /** The canvas's height: the viewport plus the overscan above and below. */
  height: number;
  /** The overscan above and below the viewport, whole rows. */
  overscan: number;
}

/**
 * The tallest backing store the band may need, in device px: well under the 16384 px texture
 * limit of desktop GPUs (and Chromium's accelerated canvas), and within 8192 for older ones.
 */
export const BAND_MAX_DEVICE_H = 8192;

/**
 * The overscan, CSS px: half a viewport height in whole rows, so the canvas is twice the
 * viewport, and the main thread can fall a quarter viewport behind a compositor scroll before the
 * band's edge shows. Half, not a whole viewport: a redraw changes every pixel of the canvas, and
 * what that costs the compositor (rasterizing and uploading it) grows with its area. At a whole
 * viewport (3x) each redraw dropped a frame in the perf probe (e2e/graph-scroll-perf.spec.ts, a
 * 1315 px viewport at dpr 2: a 1012x7894 backing store); at half (2x, 1012x5318) none did, with
 * twice as many (still rare) redraws. Cut back to fit BAND_MAX_DEVICE_H, and never under two
 * rows (a fresh band must always cover the viewport).
 */
export function bandOverscan(viewportH: number, rowH: number, dpr: number): number {
  const rows = Math.ceil(viewportH / 2 / rowH);
  const capRows = Math.floor((BAND_MAX_DEVICE_H / dpr - viewportH) / 2 / rowH);
  return Math.max(2, Math.min(rows, capRows)) * rowH;
}

/** The band to draw for scroll offset `scrollTop`: centred on the viewport, its top a whole row,
 * never above the content's top (an elastic overscroll's negative offset included). */
export function bandAt(scrollTop: number, viewportH: number, rowH: number, dpr: number): Band {
  const overscan = bandOverscan(viewportH, rowH, dpr);
  const row = Math.floor(Math.max(0, scrollTop) / rowH);
  return { top: snapScroll(Math.max(0, row * rowH - overscan), dpr), height: viewportH + 2 * overscan, overscan };
}

/** The drawn band still holds the viewport at `scrollTop` with half its overscan to spare on
 * either side (above: unless it already starts at the content's top). False: redraw. */
export function bandCovers(band: Band, scrollTop: number, viewportH: number): boolean {
  const slack = band.overscan / 2;
  const y = Math.max(0, scrollTop);
  return (band.top === 0 || y >= band.top + slack) && y + viewportH <= band.top + band.height - slack;
}
