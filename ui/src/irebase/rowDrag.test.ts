import { describe, expect, it } from 'vitest';
import { rowShifts, rowTarget } from './rowDrag';

describe('the rows\' drag (the tab drag\'s math, vertical; spec #3 §4.1)', () => {
  const tops = [0, 30, 60, 120]; // the third row is a fold target with its merged editor open (60 px)
  const heights = [30, 30, 60, 30];
  it('passes a row once the dragged row\'s leading edge crosses its midpoint', () => {
    expect(rowTarget(tops, heights, 0, 14)).toBe(0);
    expect(rowTarget(tops, heights, 0, 16)).toBe(1);
    expect(rowTarget(tops, heights, 0, 61)).toBe(2);
    expect(rowTarget(tops, heights, 3, -31)).toBe(2);
  });
  it('the rows between slide by the dragged height, leaving its landing slot empty', () => {
    expect(rowShifts(heights, 0, 2)).toEqual([90, -30, -30, 0]);
    expect(rowShifts(heights, 1, 1)).toEqual([0, 0, 0, 0]);
  });
});
