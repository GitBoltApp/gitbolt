/** Stepped zoom (spec §10.4), on a fine ladder (H24): the slider and Ctrl+wheel move one step. */
export const ZOOM_STEPS = ['fit', 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;
export type ZoomStep = (typeof ZOOM_STEPS)[number];
/** Where an image opens: 100% (H23). Fit stays on the slider's first step. */
export const DEFAULT_STEP = ZOOM_STEPS.indexOf(1);
/** Image px → screen px: `screen = image * scale + (x, y)`. Shared by every layer and side. */
export interface View { scale: number; x: number; y: number }

export const stepLabel = (s: ZoomStep) => (s === 'fit' ? 'Fit' : `${Math.round(s * 100)}%`);
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

/** The index (in ZOOM_STEPS) of the next numeric step above (1) or below (-1) `scale`. */
export function nextStepIndex(scale: number, dir: 1 | -1): number {
  const numeric: [number, number][] = [];
  ZOOM_STEPS.forEach((s, i) => { if (s !== 'fit') numeric.push([s, i]); });
  if (dir > 0) return (numeric.find(([s]) => s > scale + 1e-9) ?? numeric[numeric.length - 1])[1];
  return ([...numeric].reverse().find(([s]) => s < scale - 1e-9) ?? numeric[0])[1];
}

/** How close the swipe handle may come to the visible image's edges (H28): it stays grabbable,
 * clear of the resize handle of the panel beside it. */
export const SWIPE_MARGIN_PX = 12;

/** The swipe handle's position (px from the box's left), kept inside the part of the image on
 * screen, `SWIPE_MARGIN_PX` from its edges (H28). */
export function clampSwipe(px: number, v: View, w: number, boxW: number): number {
  const left = Math.max(0, v.x);
  const right = Math.min(boxW, v.x + w * v.scale);
  // Too small on screen for the margin: the image's own edges.
  const m = right - left > 2 * SWIPE_MARGIN_PX ? SWIPE_MARGIN_PX : 0;
  return Math.min(right - m, Math.max(left + m, px));
}
