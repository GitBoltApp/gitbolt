import { HALF_BOTTOM, HALF_FULL, HALF_TOP, type Seg } from './segments';

export interface Metrics { rowH: number; laneW: number; padX: number }
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
