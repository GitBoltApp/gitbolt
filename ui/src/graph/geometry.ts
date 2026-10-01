import { HALF_BOTTOM, HALF_FULL, HALF_TOP, type Seg } from './segments';

/** Row height, lane width and node padding; `bandInset` (default 2): the row band's and rail's
 * vertical inset, top and bottom (draw.ts). */
export interface Metrics { rowH: number; laneW: number; padX: number; bandInset?: number }
export type PathOp = { op: 'M' | 'L'; x: number; y: number } | { op: 'Q'; cx: number; cy: number; x: number; y: number };

export const laneX = (lane: number, m: Metrics) => m.padX + lane * m.laneW + m.laneW / 2;

export function segmentPath(seg: Seg, rowTop: number, m: Metrics): PathOp[] {
  const yc = rowTop + m.rowH / 2;
  const yb = rowTop + m.rowH;
  const xa = laneX(seg.from, m);
  const xb = laneX(seg.to, m);
  const r = Math.min(m.laneW / 2, m.rowH / 2);
  const dir = Math.sign(xb - xa);
  if (seg.half === HALF_FULL) return [{ op: 'M', x: xa, y: rowTop }, { op: 'L', x: xa, y: yb }];
  if (seg.half === HALF_TOP) {
    if (seg.from === seg.to) return [{ op: 'M', x: xa, y: rowTop }, { op: 'L', x: xa, y: yc }];
    return [
      { op: 'M', x: xa, y: rowTop },
      { op: 'L', x: xa, y: yc - r },
      { op: 'Q', cx: xa, cy: yc, x: xa + dir * r, y: yc },
      { op: 'L', x: xb, y: yc },
    ];
  }
  if (seg.half === HALF_BOTTOM && seg.from !== seg.to) {
    return [
      { op: 'M', x: xa, y: yc },
      { op: 'L', x: xb - dir * r, y: yc },
      { op: 'Q', cx: xb, cy: yc, x: xb, y: yc + r },
      { op: 'L', x: xb, y: yb },
    ];
  }
  return [{ op: 'M', x: xa, y: yc }, { op: 'L', x: xa, y: yb }];
}

/** Traces `path` into the context's current path (after a `beginPath`). */
export function tracePath(ctx: CanvasRenderingContext2D, path: PathOp[]): void {
  for (const p of path) {
    if (p.op === 'Q') ctx.quadraticCurveTo(p.cx, p.cy, p.x, p.y);
    else if (p.op === 'M') ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
}

/** A path's length, CSS px: its curves are measured as 16 chords, near enough to phase a dash. */
export function pathLength(path: PathOp[]): number {
  let len = 0, x = 0, y = 0;
  for (const p of path) {
    if (p.op === 'Q') {
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        const qx = u * u * x + 2 * u * t * p.cx + t * t * p.x, qy = u * u * y + 2 * u * t * p.cy + t * t * p.y;
        len += Math.hypot(qx - x, qy - y);
        x = qx; y = qy;
      }
    } else if (p.op === 'L') len += Math.hypot(p.x - x, p.y - y);
    x = p.x; y = p.y;
  }
  return len;
}
