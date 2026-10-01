import { useLayoutEffect, useState } from 'react';

/**
 * Device-pixel snapping shared by the canvas (draw.ts) and the DOM rows (GraphView, RefLabels).
 * The app zoom is the webview's page zoom, which Chromium folds into `devicePixelRatio` (120% on
 * a 1x screen is dpr 1.2), so `dpr` is the only factor: a CSS px is `dpr` device px, and anything
 * that must stay crisp or line up across the DOM/canvas boundary is placed on whole device pixels.
 */

/** The window's device pixel ratio, updated when it changes with no resize (a monitor move, the
 * OS scale or the app zoom). `matchMedia`'s query only matches at the dpr it was created with, so
 * each firing re-arms a fresh query at the new dpr rather than listening once. */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useLayoutEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [dpr]);
  return dpr;
}

/** `css` CSS px as a whole number of device px (at least 1). */
export const devicePx = (css: number, dpr: number) => Math.max(1, Math.round(css * dpr));

/** A scroll offset on the device pixel grid, CSS px. Chromium scrolls by whole device pixels, so
 * this is `scrollTop` itself, minus the float noise of `scrollTop * dpr`. */
export const snapScroll = (scrollTop: number, dpr: number) => Math.round(scrollTop * dpr) / dpr;

/**
 * A row's chip-to-node connector (K57): `lineW` CSS px thick, centred on the row, its top edge on
 * a device pixel row. Computed once, in content coordinates (the row's `top` in the scrolled
 * content, i.e. its index times the row height), for both halves: the DOM connector takes
 * `top - rowTop` and `height`, the canvas strokes at `centre` less the snapped scroll, so the
 * two cover exactly the same device rows. Both are placed from the graph body's top, which may
 * itself sit a fraction of a device px off the grid (the layout above it at a fractional zoom):
 * Chromium snaps the DOM box and the canvas element alike, so they still land on the same rows.
 */
export function connectorLine(rowTop: number, rowH: number, lineW: number, dpr: number): { top: number; height: number; centre: number } {
  const wDev = devicePx(lineW, dpr);
  const topDev = Math.round((rowTop + rowH / 2) * dpr - wDev / 2);
  return { top: topDev / dpr, height: wDev / dpr, centre: (topDev + wDev / 2) / dpr };
}

/** A dash pattern's dash (and gap) length: `css` rounded to whole device px, back in CSS px. */
export const dashLength = (css: number, dpr: number) => devicePx(css, dpr) / dpr;

/**
 * `lineDashOffset` for a dashed line that starts at content y `y` and runs down (K50): the
 * pattern's phase is the absolute content y, so every piece of a dashed lane (one path per row,
 * or a run of rows) continues the same dashes, and a dash boundary falls wherever
 * `y * dpr` is a multiple of the (whole device px) dash: on the device pixel grid, once the
 * snapped scroll is subtracted. A path that only turns vertical later passes the y its
 * vertical part would have started at, had it run straight (its end's y less its length).
 */
export function dashOffset(y: number, dash: number): number {
  const period = 2 * dash;
  return ((y % period) + period) % period;
}

/** A dotted ring's dash (and gap) length: close to `target`, dividing the circumference into a
 * whole number of dash+gap pairs, so there's no odd dash where the stroke starts and ends. */
export function ringDash(radius: number, target: number): number {
  const c = 2 * Math.PI * radius;
  return c / (2 * Math.max(2, Math.round(c / (2 * target))));
}
