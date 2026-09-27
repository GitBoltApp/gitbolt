/** Stepped zoom (spec §10.4). */
export const ZOOM_STEPS = ['fit', 0.25, 0.5, 1, 2, 4, 6, 8, 10] as const;
export type ZoomStep = (typeof ZOOM_STEPS)[number];
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
