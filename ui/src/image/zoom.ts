/** Stepped zoom (spec §10.4), on a fine ladder (H24): the slider and Ctrl+wheel move one step.
 * K12: Fit is a dedicated button, not a rung — the slider's minimum is this ladder's own first
 * (fixed) rung, not a computed fit percentage. */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;
export type ZoomStep = (typeof ZOOM_STEPS)[number];
/** Where an image opens: 100% (H23). */
export const DEFAULT_STEP = ZOOM_STEPS.indexOf(1);
/** Image px → screen px: `screen = image * scale + (x, y)`. Shared by every layer and side. */
export interface View { scale: number; x: number; y: number }

export const stepLabel = (s: ZoomStep) => `${Math.round(s * 100)}%`;
export const pixelated = (scale: number) => scale > 1;

export function fitScale(w: number, h: number, boxW: number, boxH: number): number {
  if (w <= 0 || h <= 0 || boxW <= 0 || boxH <= 0) return 1;
  return Math.min(10, boxW / w, boxH / h);
}

export function centered(scale: number, w: number, h: number, boxW: number, boxH: number): View {
  return { scale, x: (boxW - w * scale) / 2, y: (boxH - h * scale) / 2 };
}

/** One axis of `clampView`: centred when the image fits, else kept covering the box. */
const clampAxis = (pos: number, size: number, box: number) => (size <= box ? (box - size) / 2 : Math.min(0, Math.max(box - size, pos)));

/**
 * The view, panned only where the image is larger than the box (H27): on an axis where it fits
 * it's centred (a drag does nothing), and where it's larger it can't be dragged off-screen, its
 * edges never inside the box.
 */
export function clampView(v: View, w: number, h: number, boxW: number, boxH: number): View {
  if (w <= 0 || h <= 0) return v;
  return { scale: v.scale, x: clampAxis(v.x, w * v.scale, boxW), y: clampAxis(v.y, h * v.scale, boxH) };
}

/** Where an image opens at `scale` (H23): its top left where it overflows, centred where it fits. */
export const startView = (scale: number, w: number, h: number, boxW: number, boxH: number): View => clampView({ scale, x: 0, y: 0 }, w, h, boxW, boxH);

/** Changes the scale while keeping the image point under `(px, py)` where it is. */
export function zoomAround(v: View, scale: number, px: number, py: number): View {
  const ix = (px - v.x) / v.scale;
  const iy = (py - v.y) / v.scale;
  return { scale, x: px - ix * scale, y: py - iy * scale };
}

/** Wheel travel (px) per zoom step: a mouse notch (~100 px) is one step, a trackpad pinch accumulates. */
const WHEEL_STEP_PX = 50;
const WHEEL_UNIT_PX = [1, 20, 400]; // by WheelEvent.deltaMode: pixel, line, page

/** A wheel's zoom steps: each event answers 1 (zoom in: the wheel turned up), -1 (out) or 0 (not
 * a step yet). Travel adds up until it's a step; turning the other way starts over. */
export function wheelAccumulator(): (e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>) => 1 | -1 | 0 {
  let acc = 0;
  return (e) => {
    const dy = e.deltaY * (WHEEL_UNIT_PX[e.deltaMode] ?? 1);
    if (dy === 0) return 0;
    if (Math.sign(dy) !== Math.sign(acc)) acc = 0;
    acc += dy;
    if (Math.abs(acc) < WHEEL_STEP_PX) return 0;
    acc = 0;
    return dy < 0 ? 1 : -1;
  };
}

/** The index (in ZOOM_STEPS) of the next step above (1) or below (-1) `scale`. */
export function nextStepIndex(scale: number, dir: 1 | -1): number {
  if (dir > 0) {
    const i = ZOOM_STEPS.findIndex((s) => s > scale + 1e-9);
    return i === -1 ? ZOOM_STEPS.length - 1 : i;
  }
  const i = [...ZOOM_STEPS].reverse().findIndex((s) => s < scale - 1e-9);
  return i === -1 ? 0 : ZOOM_STEPS.length - 1 - i;
}

/** The rung closest to an arbitrary `scale` (K12/K13: Fit or a typed exact percent rarely land on
 * one) — only for the slider thumb's position; the exact scale is kept regardless. */
export function nearestStepIndex(scale: number): number {
  let best = 0;
  let bestDiff = Infinity;
  ZOOM_STEPS.forEach((s, i) => {
    const d = Math.abs(s - scale);
    if (d < bestDiff) { bestDiff = d; best = i; }
  });
  return best;
}

/** How close the swipe handle may come to the VIEWPORT's edges (never the image's, J10): its 3 px
 * line stays on screen, and clear of the right panel's resizer, which overlaps the centre by 2 px
 * (repo.css `.panel-resizer`). */
export const SWIPE_VIEWPORT_EDGE_PX = 4;

/** The swipe handle's position (px from the box's left): anywhere over the image, its left edge
 * (0%) to its right edge (100%, J10), except that it stays `SWIPE_VIEWPORT_EDGE_PX` inside the
 * viewport where the image reaches or passes the viewport's edges (zoomed in). */
export function clampSwipe(px: number, v: View, w: number, boxW: number): number {
  const left = Math.max(SWIPE_VIEWPORT_EDGE_PX, v.x);
  const right = Math.max(left, Math.min(boxW - SWIPE_VIEWPORT_EDGE_PX, v.x + w * v.scale));
  return Math.min(right, Math.max(left, px));
}
