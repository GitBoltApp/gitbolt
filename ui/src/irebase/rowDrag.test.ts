import { describe, expect, it } from 'vitest';
import { groupTarget, slotShifts } from './rowDrag';

describe('the rows\' drag (the tab drag\'s math, vertical; spec #3 §4.1)', () => {
  const heights = [30, 30, 60, 30]; // the third row is a fold target with its merged editor open (60 px)
  it('passes a row once the dragged row\'s leading edge crosses its midpoint', () => {
    expect(groupTarget(heights, [0], 0, 14)).toBe(0);
    expect(groupTarget(heights, [0], 0, 16)).toBe(1);
    expect(groupTarget(heights, [0], 0, 61)).toBe(2);
    expect(groupTarget(heights, [3], 3, -31)).toBe(2);
    expect(groupTarget(heights, [3], 3, 0)).toBe(3);
  });
  it('the rows between slide by the dragged height, leaving its landing slot empty', () => {
    expect(slotShifts(heights, [0], 2)).toEqual([90, -30, -30, 0]);
    expect(slotShifts(heights, [1], 1)).toEqual([0, 0, 0, 0]);
  });
});

describe('a group drag (UX2 E.3)', () => {
  const h = [30, 30, 30, 30, 30, 30];
  it('a contiguous group stays put until its block crosses a neighbour\'s midpoint, from whichever row is pressed', () => {
    expect(groupTarget(h, [1, 2], 1, 0)).toBe(1);
    expect(groupTarget(h, [1, 2], 2, 0)).toBe(1);
    expect(groupTarget(h, [1, 2], 2, -16)).toBe(0);
    expect(groupTarget(h, [1, 2], 1, 16)).toBe(2);
    expect(groupTarget(h, [1, 2], 1, 46)).toBe(3);
  });
  it('a scattered group closes up around the pressed row: the others make room for the block', () => {
    // Rows 1 and 4 dragged from 4, not moved yet: row 1 joins it, 2 and 3 close the gap.
    expect(groupTarget(h, [1, 4], 4, 0)).toBe(3);
    expect(slotShifts(h, [1, 4], 3)).toEqual([0, 60, -30, -30, 0, 0]);
    // To the top.
    expect(groupTarget(h, [1, 4], 4, -200)).toBe(0);
    expect(slotShifts(h, [1, 4], 0)).toEqual([60, -30, 30, 30, -90, 0]);
  });
});
