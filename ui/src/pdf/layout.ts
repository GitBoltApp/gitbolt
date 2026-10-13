// A PDF's pages laid out in a column, and the side-by-side diff's scroll sync. No React here.
import { ZOOM_STEPS } from '../image/zoom';

/** A page's size in PDF points (1/72 in), at zoom 1. */
export interface PageSize { w: number; h: number }

/** The gap between pages, and the column's padding around them (px, unzoomed). */
export const PAGE_GAP = 12;

/** Each page's top (px) in a column of `sizes` at `scale`. */
export function pageTops(sizes: readonly PageSize[], scale: number): number[] {
  const tops: number[] = [];
  let y = PAGE_GAP;
  for (const s of sizes) {
    tops.push(y);
    y += Math.round(s.h * scale) + PAGE_GAP;
  }
  return tops;
}

/** The column's full height at `scale`. */
export const columnHeight = (sizes: readonly PageSize[], scale: number) =>
  sizes.reduce((y, s) => y + Math.round(s.h * scale) + PAGE_GAP, PAGE_GAP);

/** The page (0-based) at `y` px down the column: the last one starting at or above it. */
export function pageAt(tops: readonly number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** The page the reader is on: the one at the pane's top third, so a page counts once it fills most of the view. */
export const currentPage = (tops: readonly number[], scrollTop: number, paneHeight: number) =>
  tops.length === 0 ? 0 : pageAt(tops, scrollTop + paneHeight / 3);

/**
 * The side-by-side diff's scroll sync: where the other side scrolls to so its page `n` lines up
 * with this side's page `n`, at the same point down the page. A side with fewer pages stops at
 * its end; pages of different heights line up by their fraction scrolled.
 */
export function syncedScrollTop(from: { sizes: readonly PageSize[]; scale: number }, to: { sizes: readonly PageSize[]; scale: number }, scrollTop: number): number {
  if (from.sizes.length === 0 || to.sizes.length === 0) return 0;
  // Each page's block is the gap above it and the page.
  const fromTops = pageTops(from.sizes, from.scale);
  const toTops = pageTops(to.sizes, to.scale);
  const i = pageAt(fromTops, scrollTop + PAGE_GAP);
  if (i >= to.sizes.length) return columnHeight(to.sizes, to.scale);
  const fromH = Math.round(from.sizes[i].h * from.scale) + PAGE_GAP;
  const toH = Math.round(to.sizes[i].h * to.scale) + PAGE_GAP;
  const fraction = Math.min(1, Math.max(0, (scrollTop - (fromTops[i] - PAGE_GAP)) / fromH));
  return toTops[i] - PAGE_GAP + fraction * toH;
}

/** How far past the pane's edges pages are drawn ahead of the scroll (px). */
export const DRAW_AHEAD = 800;

/** The pages (0-based, in order) within `DRAW_AHEAD` of the pane's view: the ones drawn. */
export function visiblePages(sizes: readonly PageSize[], scale: number, scrollTop: number, paneHeight: number): number[] {
  const tops = pageTops(sizes, scale);
  const from = scrollTop - DRAW_AHEAD;
  const to = scrollTop + paneHeight + DRAW_AHEAD;
  const out: number[] = [];
  for (let i = pageAt(tops, Math.max(0, from)); i < tops.length && tops[i] <= to; i++) {
    if (tops[i] + sizes[i].h * scale >= from) out.push(i);
  }
  return out;
}

/** The zoom ladder's ends (the image zoom's): Fit width stays within them too. */
const MIN_SCALE = ZOOM_STEPS[0];
const MAX_SCALE = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** The zoom that fits the widest page in a pane `paneWidth` px wide. */
export function fitWidthScale(sizes: readonly PageSize[], paneWidth: number): number {
  const widest = Math.max(0, ...sizes.map((s) => s.w));
  if (widest <= 0 || paneWidth <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, (paneWidth - 2 * PAGE_GAP) / widest));
}

/** The most pixels a page's canvas gets (pdf.js's own `maxCanvasPixels`): 16 megapixels. */
export const MAX_CANVAS_PIXELS = 2 ** 24;

/** Canvas pixels per CSS pixel for a page drawn at `scale`: the screen's ratio, or less for a
 * page so large (or zoomed so far) that it would pass `MAX_CANVAS_PIXELS`; the canvas is then
 * stretched to the page's box. */
export function canvasRatio(size: PageSize, scale: number, devicePixelRatio: number): number {
  const css = size.w * scale * size.h * scale;
  return css <= 0 ? devicePixelRatio : Math.min(devicePixelRatio, Math.sqrt(MAX_CANVAS_PIXELS / css));
}
