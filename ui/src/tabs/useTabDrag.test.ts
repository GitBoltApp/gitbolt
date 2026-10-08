import { describe, expect, it } from 'vitest';
import { clampDx, dropAt, layoutOffsets, tabDragRange, tabDropAt, targetIndex, type DragBox, type StripGeometry } from './useTabDrag';

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

describe('dropAt: a tab\'s middle takes a drop onto it, its edges keep meaning reorder', () => {
  const all = () => true;
  it('dragging right: the leading edge in the middle 40% of a tab is a drop onto it', () => {
    // Tab 1 spans 110..310: its middle zone is 170..250 (30% to 70%), passed past 250.
    expect(dropAt(g, 0, 50, all)).toEqual({ to: 0, onto: null }); // edge 160: not there yet
    expect(dropAt(g, 0, 70, all)).toEqual({ to: 0, onto: 1 }); // edge 180
    expect(dropAt(g, 0, 130, all)).toEqual({ to: 0, onto: 1 }); // edge 240: past the midpoint, still onto
    expect(dropAt(g, 0, 150, all)).toEqual({ to: 1, onto: null }); // edge 260: passed
  });

  it('dragging left: mirrored, from the tab\'s right edge', () => {
    // Tab 2 (310..370) dragged left over tab 1: onto while its left edge is in 170..250.
    expect(dropAt(g, 2, -100, all)).toEqual({ to: 2, onto: 1 }); // edge 210
    expect(dropAt(g, 2, -150, all)).toEqual({ to: 1, onto: null }); // edge 160: passed
  });

  it('a tab that can\'t take a drop is passed at its midpoint, as before', () => {
    expect(dropAt(g, 0, 101, () => false)).toEqual({ to: 1, onto: null });
    expect(dropAt(g, 0, 70, (j) => j !== 1)).toEqual({ to: 0, onto: null });
  });
});

describe('layoutOffsets', () => {
  it('how far each item moves to show the order a drop gives, chips included', () => {
    // Laid out: a(0,100) [chip](100,20) b(120,100) c(220,100); the preview order puts a after b.
    const lefts = { a: 0, chip: 100, b: 120, c: 220 };
    const widths = { a: 100, chip: 20, b: 100, c: 100 };
    expect(layoutOffsets(['chip', 'b', 'a', 'c'], lefts, widths, 0)).toEqual({ chip: -100, b: -100, a: 120, c: 0 });
  });

  it('the current order: nothing moves', () => {
    expect(layoutOffsets(['a', 'b'], { a: 10, b: 110 }, { a: 100, b: 50 }, 10)).toEqual({ a: 0, b: 0 });
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

// A tab dragged among tabs and groups: boxes laid end to end from x=0, chips 24 wide, tabs 100.
const strip = (...spec: string[]): DragBox[] => {
  let x = 0;
  return spec.map((s) => {
    const [kind, group = null] = s.split(':');
    const width = kind === 'chip' ? 24 : kind === 'block' ? 124 : 100;
    const box = kind === 'chip' ? { kind, group: group!, left: x, width } : kind === 'block' ? { kind, left: x, width } : { kind: 'tab', group, left: x, width };
    x += width;
    return box as DragBox;
  });
};

// Zones: ZONE of the dragged tab's width (100 here: 40 px) for each slot at a group's edge.
describe('tabDropAt: where a dragged tab lands among tabs and groups', () => {
  it('between two groups, dragged left across the right one\'s chip: its first slot, between them, the left one\'s last slot', () => {
    // [g1] 0..24, a 24..124, b 124..224, [g2] 224..248, c 248..348, y 348..448: y dragged left.
    const items = strip('chip:g1', 'tab:g1', 'tab:g1', 'chip:g2', 'tab:g2', 'tab');
    expect(tabDropAt(items, 5, -30)).toEqual({ gap: 5, group: null });
    expect(tabDropAt(items, 5, -50)).toEqual({ gap: 5, group: 'g2' }); // g2's last slot
    // (a) g2's first slot, the chip staying put: until y's left edge reaches the chip's left (224).
    expect(tabDropAt(items, 5, -82)).toEqual({ gap: 4, group: 'g2' });
    expect(tabDropAt(items, 5, -122)).toEqual({ gap: 4, group: 'g2' });
    // (b) between the groups, in none (the chip moves aside): 40 px.
    expect(tabDropAt(items, 5, -126)).toEqual({ gap: 3, group: null });
    expect(tabDropAt(items, 5, -162)).toEqual({ gap: 3, group: null });
    // (c) g1's last slot: 40 px more.
    expect(tabDropAt(items, 5, -166)).toEqual({ gap: 3, group: 'g1' });
    expect(tabDropAt(items, 5, -202)).toEqual({ gap: 3, group: 'g1' });
    // Then b's slot, back at b's own midpoint and a's: the push doesn't carry on down the strip.
    expect(tabDropAt(items, 5, -206)).toEqual({ gap: 2, group: 'g1' });
    expect(tabDropAt(items, 5, -276)).toEqual({ gap: 1, group: 'g1' });
  });

  it('the same zones dragged right, mirrored: the left group\'s last slot, between, the right one\'s first slot', () => {
    // y 0..100, [g1] 100..124, a 124..224, [g2] 224..248, c 248..348: y dragged right.
    const items = strip('tab', 'chip:g1', 'tab:g1', 'chip:g2', 'tab:g2');
    expect(tabDropAt(items, 0, 30)).toEqual({ gap: 0, group: null }); // 40 px before joining
    expect(tabDropAt(items, 0, 50)).toEqual({ gap: 1, group: 'g1' });
    expect(tabDropAt(items, 0, 90)).toEqual({ gap: 2, group: 'g1' }); // (c) g1's last slot
    expect(tabDropAt(items, 0, 120)).toEqual({ gap: 2, group: 'g1' });
    expect(tabDropAt(items, 0, 130)).toEqual({ gap: 2, group: null }); // (b) its right edge past g1's end
    expect(tabDropAt(items, 0, 160)).toEqual({ gap: 2, group: null });
    expect(tabDropAt(items, 0, 170)).toEqual({ gap: 3, group: 'g2' }); // (a) g2's first slot
    expect(tabDropAt(items, 0, 200)).toEqual({ gap: 3, group: 'g2' });
    expect(tabDropAt(items, 0, 210)).toEqual({ gap: 4, group: 'g2' });
  });

  it('hysteresis: a zone is left only 10 px past its edge, either way', () => {
    const items = strip('chip:g1', 'tab:g1', 'tab:g1', 'chip:g2', 'tab:g2', 'tab');
    const a = { gap: 4, group: 'g2' };
    const b = { gap: 3, group: null };
    // The (a)/(b) edge is at -124.
    expect(tabDropAt(items, 5, -126, a)).toEqual(a);
    expect(tabDropAt(items, 5, -133, a)).toEqual(a);
    expect(tabDropAt(items, 5, -135, a)).toEqual(b);
    expect(tabDropAt(items, 5, -122, b)).toEqual(b);
    expect(tabDropAt(items, 5, -115, b)).toEqual(b);
    expect(tabDropAt(items, 5, -113, b)).toEqual(a);
    // Far from the held zone: wherever the tab is.
    expect(tabDropAt(items, 5, -170, a)).toEqual({ gap: 3, group: 'g1' });
    // Dragged right too: (c) to (b) at +124.
    const r = strip('tab', 'chip:g1', 'tab:g1', 'chip:g2', 'tab:g2');
    expect(tabDropAt(r, 0, 130, { gap: 2, group: 'g1' })).toEqual({ gap: 2, group: 'g1' });
    expect(tabDropAt(r, 0, 135, { gap: 2, group: 'g1' })).toEqual({ gap: 2, group: null });
  });

  it('between a group and an ungrouped tab: after the tab\'s onto zone, between them, then the group\'s last slot', () => {
    // [g] 0..24, a 24..124, u 124..224, y 224..324: y dragged left.
    const items = strip('chip:g', 'tab:g', 'tab', 'tab');
    expect(tabDropAt(items, 3, -40)).toEqual({ onto: 2 });
    expect(tabDropAt(items, 3, -80)).toEqual({ gap: 2, group: null }); // between u and the group
    expect(tabDropAt(items, 3, -128)).toEqual({ gap: 2, group: null });
    expect(tabDropAt(items, 3, -132)).toEqual({ gap: 2, group: 'g' }); // its last slot: 40 px
    expect(tabDropAt(items, 3, -168)).toEqual({ gap: 2, group: 'g' });
    expect(tabDropAt(items, 3, -172)).toEqual({ gap: 1, group: 'g' });
  });

  it('a group after an ungrouped tab: its first slot, between them, then onto the tab', () => {
    // u 0..100, [g] 100..124, c 124..224, y 224..324: y dragged left.
    const items = strip('tab', 'chip:g', 'tab:g', 'tab');
    expect(tabDropAt(items, 3, -50)).toEqual({ gap: 3, group: 'g' });
    expect(tabDropAt(items, 3, -90)).toEqual({ gap: 2, group: 'g' }); // (a) its first slot
    expect(tabDropAt(items, 3, -126)).toEqual({ gap: 1, group: null }); // (b) its left edge past the chip
    expect(tabDropAt(items, 3, -162)).toEqual({ gap: 1, group: null });
    expect(tabDropAt(items, 3, -166)).toEqual({ onto: 0 });
    expect(tabDropAt(items, 3, -200)).toEqual({ gap: 0, group: null });
  });

  it('the last group at the strip\'s end: its last tab leaves it to the right, 40 px on', () => {
    // a 0..100, [g] 100..124, b 124..224, c 224..324 (the strip's last item).
    const items = strip('tab', 'chip:g', 'tab:g', 'tab:g');
    expect(tabDropAt(items, 3, 30)).toEqual({ gap: 3, group: 'g' });
    expect(tabDropAt(items, 3, 50)).toEqual({ gap: 3, group: null });
    // A full strip still lets it get there, and half a zone on: past the strip's ends as far as that takes.
    expect(tabDragRange(items, 3, 0, 324)).toEqual({ lo: -224, hi: 60 });
    // An empty strip after the tabs is the drop zone.
    expect(tabDragRange(items, 3, 0, 800).hi).toBe(476);
  });

  it('the first group at the strip\'s start can be left to the left too', () => {
    // [g] 0..24, b 24..124, c 124..224: c dragged left.
    const items = strip('chip:g', 'tab:g', 'tab:g');
    expect(tabDragRange(items, 2, 0, 600).lo).toBe(-144);
    expect(tabDropAt(items, 2, -120)).toEqual({ gap: 1, group: 'g' });
    expect(tabDropAt(items, 2, -130)).toEqual({ gap: 0, group: null });
  });

  it('from one group into the next: out of the first past its end, then into the second', () => {
    // [g1] 0..24, a 24..124, b 124..224, [g2] 224..248, c 248..348: b dragged right.
    const items = strip('chip:g1', 'tab:g1', 'tab:g1', 'chip:g2', 'tab:g2');
    expect(tabDropAt(items, 2, 35)).toEqual({ gap: 2, group: 'g1' });
    expect(tabDropAt(items, 2, 45)).toEqual({ gap: 2, group: null });
    expect(tabDropAt(items, 2, 85)).toEqual({ gap: 3, group: 'g2' }); // g2's first tab
    expect(tabDropAt(items, 2, 125)).toEqual({ gap: 4, group: 'g2' });
  });

  it('only an ungrouped tab takes a drop onto it; a collapsed group is passed whole', () => {
    // x 0..100, a 100..200: x's right edge in a's middle makes a group.
    expect(tabDropAt(strip('tab', 'tab'), 0, 50)).toEqual({ onto: 1 });
    // x 0..100, [block] 100..224, d 224..324: the block is passed at its middle, never entered.
    const items = strip('tab', 'block', 'tab');
    expect(tabDropAt(items, 0, 60)).toEqual({ gap: 0, group: null });
    expect(tabDropAt(items, 0, 64)).toEqual({ gap: 1, group: null });
  });

  it('zones are a fraction of the dragged tab\'s width, at most 44 px: a long name doesn\'t take more travel', () => {
    // [g1] 0..24, a 24..124, [g2] 124..148, c 148..248, y 248..448 (wide): y dragged left.
    const items = strip('chip:g1', 'tab:g1', 'chip:g2', 'tab:g2', 'tab');
    items[4] = { ...items[4], width: 200 };
    expect(tabDropAt(items, 4, -50)).toEqual({ gap: 4, group: 'g2' });
    expect(tabDropAt(items, 4, -120)).toEqual({ gap: 3, group: 'g2' }); // (a)
    expect(tabDropAt(items, 4, -134)).toEqual({ gap: 2, group: null }); // (b): 44 px
    expect(tabDropAt(items, 4, -174)).toEqual({ gap: 2, group: null });
    expect(tabDropAt(items, 4, -178)).toEqual({ gap: 2, group: 'g1' }); // (c): 44 px
    expect(tabDropAt(items, 4, -218)).toEqual({ gap: 2, group: 'g1' });
    expect(tabDropAt(items, 4, -222)).toEqual({ gap: 1, group: 'g1' });
  });
});
