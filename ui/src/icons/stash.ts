import { Archive } from 'lucide-react';

/**
 * The stash icon (a paper tray): the toolbar Stash button, the sidebar Stashes section and its
 * rows, and (drawn on the canvas from the same geometry) the graph's stash nodes.
 */
export const StashIcon = Archive;

/** Lucide `archive`'s geometry (its 24-unit box, stroke 2), for the canvas, where an SVG
 * component can't go. Keep in step with `StashIcon`. */
export const STASH_ICON_BOX = 24;
export const STASH_ICON_STROKE = 2;

/** Traces the icon into `ctx` (one path, to stroke), centred on (cx, cy), `size` px square. */
export function traceStashIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const k = size / STASH_ICON_BOX;
  const X = (u: number) => cx + (u - STASH_ICON_BOX / 2) * k;
  const Y = (u: number) => cy + (u - STASH_ICON_BOX / 2) * k;
  // The lid: rect x 2..22, y 3..8, rx 1.
  const r = k;
  ctx.moveTo(X(3), Y(3));
  ctx.lineTo(X(21), Y(3));
  ctx.arcTo(X(22), Y(3), X(22), Y(4), r);
  ctx.lineTo(X(22), Y(7));
  ctx.arcTo(X(22), Y(8), X(21), Y(8), r);
  ctx.lineTo(X(3), Y(8));
  ctx.arcTo(X(2), Y(8), X(2), Y(7), r);
  ctx.lineTo(X(2), Y(4));
  ctx.arcTo(X(2), Y(3), X(3), Y(3), r);
  ctx.closePath();
  // The tray: M4 8 v11 a2 2 0 0 0 2 2 h12 a2 2 0 0 0 2-2 V8.
  ctx.moveTo(X(4), Y(8));
  ctx.lineTo(X(4), Y(19));
  ctx.arcTo(X(4), Y(21), X(6), Y(21), 2 * k);
  ctx.lineTo(X(18), Y(21));
  ctx.arcTo(X(20), Y(21), X(20), Y(19), 2 * k);
  ctx.lineTo(X(20), Y(8));
  // The handle slot: M10 12 h4.
  ctx.moveTo(X(10), Y(12));
  ctx.lineTo(X(14), Y(12));
}
