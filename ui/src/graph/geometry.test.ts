import { describe, expect, it } from 'vitest';
import { decodeSegment, HALF_BOTTOM, HALF_FULL, HALF_TOP } from './segments';
import { laneX, segmentPath, type Metrics } from './geometry';

const m: Metrics = { rowH: 22, laneW: 16, padX: 8 };
const pack = (from: number, to: number, half: number, color: number, dashed: boolean) =>
  from | (to << 10) | (half << 20) | (color << 22) | ((dashed ? 1 : 0) << 26);

describe('decodeSegment', () => {
  it('matches the Rust packing', () => {
    expect(decodeSegment(pack(1023, 7, HALF_FULL, 9, true))).toEqual({ from: 1023, to: 7, half: HALF_FULL, color: 9, dashed: true });
    expect(decodeSegment(0)).toEqual({ from: 0, to: 0, half: HALF_TOP, color: 0, dashed: false });
  });
  it('golden: Rust cross-language contract', () => {
    expect(decodeSegment(0x04d00801)).toEqual({ from: 1, to: 2, half: HALF_BOTTOM, color: 3, dashed: true });
  });
});

describe('segmentPath', () => {
  it('lane centres', () => {
    expect(laneX(0, m)).toBe(16);
    expect(laneX(2, m)).toBe(48);
  });
  it('full pass-through', () => {
    expect(segmentPath(decodeSegment(pack(1, 1, HALF_FULL, 1, false)), 100, m)).toEqual([
      { op: 'M', x: 32, y: 100 },
      { op: 'L', x: 32, y: 122 },
    ]);
  });
  it('straight top and bottom halves', () => {
    expect(segmentPath(decodeSegment(pack(0, 0, HALF_TOP, 0, false)), 0, m)).toEqual([{ op: 'M', x: 16, y: 0 }, { op: 'L', x: 16, y: 11 }]);
    expect(segmentPath(decodeSegment(pack(0, 0, HALF_BOTTOM, 0, false)), 0, m)).toEqual([{ op: 'M', x: 16, y: 11 }, { op: 'L', x: 16, y: 22 }]);
  });
  it('merge-in curve from lane 2 into node at lane 0', () => {
    expect(segmentPath(decodeSegment(pack(2, 0, HALF_TOP, 2, false)), 0, m)).toEqual([
      { op: 'M', x: 48, y: 0 },
      { op: 'L', x: 48, y: 3 },
      { op: 'Q', cx: 48, cy: 11, x: 40, y: 11 },
      { op: 'L', x: 16, y: 11 },
    ]);
  });
  it('branch-out curve from node at lane 0 to lane 1', () => {
    expect(segmentPath(decodeSegment(pack(0, 1, HALF_BOTTOM, 1, false)), 0, m)).toEqual([
      { op: 'M', x: 16, y: 11 },
      { op: 'L', x: 24, y: 11 },
      { op: 'Q', cx: 32, cy: 11, x: 32, y: 19 },
      { op: 'L', x: 32, y: 22 },
    ]);
  });
  it('top curve with negative dir (lane 1 to lane 0)', () => {
    expect(segmentPath(decodeSegment(pack(1, 0, HALF_TOP, 0, false)), 0, m)).toEqual([
      { op: 'M', x: 32, y: 0 },
      { op: 'L', x: 32, y: 3 },
      { op: 'Q', cx: 32, cy: 11, x: 24, y: 11 },
      { op: 'L', x: 16, y: 11 },
    ]);
  });
  it('bottom curve with negative dir (lane 1 to lane 0)', () => {
    expect(segmentPath(decodeSegment(pack(1, 0, HALF_BOTTOM, 0, false)), 0, m)).toEqual([
      { op: 'M', x: 32, y: 11 },
      { op: 'L', x: 24, y: 11 },
      { op: 'Q', cx: 16, cy: 11, x: 16, y: 19 },
      { op: 'L', x: 16, y: 22 },
    ]);
  });
  it('radius clamped when laneW > rowH', () => {
    const mBig = { rowH: 10, laneW: 30, padX: 8 };
    expect(segmentPath(decodeSegment(pack(0, 1, HALF_TOP, 0, false)), 0, mBig)).toEqual([
      { op: 'M', x: 23, y: 0 },
      { op: 'L', x: 23, y: 0 },
      { op: 'Q', cx: 23, cy: 5, x: 28, y: 5 },
      { op: 'L', x: 53, y: 5 },
    ]);
  });
});
