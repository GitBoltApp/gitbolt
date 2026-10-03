import { describe, expect, it } from 'vitest';
import { clampDx, shifts, targetIndex, type StripGeometry } from './useTabDrag';

// Variable widths: 100, 200, 60, 140 starting at x=10 (midpoints 60, 210, 340, 440), in a strip
// from 0 to 600.
const g: StripGeometry = { lefts: [10, 110, 310, 370], widths: [100, 200, 60, 140], stripLeft: 0, stripRight: 600 };

describe('targetIndex: midpoint crossing with variable widths', () => {
  it('passes a neighbour once the dragged tab\'s leading edge crosses that neighbour\'s midpoint', () => {
    // Tab 0's right edge is 110; tab 1's midpoint is 210: a 99 px drag stays, 101 px crosses.
    expect(targetIndex(g, 0, 99)).toBe(0);
    expect(targetIndex(g, 0, 101)).toBe(1);
    // Tab 2's midpoint is 340: crossing it too lands at 2.
    expect(targetIndex(g, 0, 231)).toBe(2);
    // Leftward: the narrow tab 2 (left edge 310) passes the wide tab 1 (midpoint 210) at -100.
    expect(targetIndex(g, 2, -99)).toBe(2);
    expect(targetIndex(g, 2, -101)).toBe(1);
    expect(targetIndex(g, 2, -300)).toBe(0);
  });

  it('a wide tab clamped at the end still passes a narrower last tab', () => {
    // Tab 1 (200 wide) clamped at +200: its right edge (510) is past tab 3's midpoint (440).
    expect(targetIndex(g, 1, clampDx(g, 1, 999))).toBe(3);
  });

  it('back over its own slot is no move', () => {
    expect(targetIndex(g, 1, 0)).toBe(1);
    expect(targetIndex(g, 1, -20)).toBe(1);
  });
});

describe('shifts', () => {
  it('slides the tabs between the slots by the dragged width, leaving its slot empty', () => {
    // Tab 0 (100 wide) to index 2: tabs 1 and 2 move left by 100; tab 0's slot is at +260.
    expect(shifts(g.widths, 0, 2)).toEqual([260, -100, -100, 0]);
    // Tab 3 (140 wide) to index 1: tabs 1 and 2 move right by 140; tab 3's slot is at -260.
    expect(shifts(g.widths, 3, 1)).toEqual([0, 140, 140, -260]);
  });

  it('cancel (to = from): every tab, the dragged one included, goes home', () => {
    expect(shifts(g.widths, 1, 1)).toEqual([0, 0, 0, 0]);
  });
});

describe('clampDx', () => {
  it('keeps the dragged tab over the tabs, inside the strip', () => {
    expect(clampDx(g, 1, -500)).toBe(-100); // tab 1's left can reach tab 0's left (10)
    expect(clampDx(g, 1, 500)).toBe(200); // tab 1's right can reach the last tab's right (510)
    expect(clampDx(g, 1, 30)).toBe(30);
    // Tabs clipped past the strip's right edge: the strip wins.
    expect(clampDx({ ...g, stripRight: 400 }, 0, 999)).toBe(290);
  });
});
