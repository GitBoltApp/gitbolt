/** Decoder for `graph::Segment::pack` (Rust). Bits: from 0-9, to 10-19, half 20-21, color 22-25, dashed 26. */
export const HALF_TOP = 0;
export const HALF_BOTTOM = 1;
export const HALF_FULL = 2;

export interface Seg { from: number; to: number; half: number; color: number; dashed: boolean }

export function decodeSegment(p: number): Seg {
  return { from: p & 0x3ff, to: (p >>> 10) & 0x3ff, half: (p >>> 20) & 0x3, color: (p >>> 22) & 0xf, dashed: ((p >>> 26) & 1) === 1 };
}
