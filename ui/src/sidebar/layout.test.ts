import { describe, expect, it } from 'vitest';
import { dividerTargets, HEADER_H, ICON_W, INDENT_STEP, layoutPanels, ROW_GAP, ROW_PAD, rowIndent, MIN_PANEL_H, resizePair, type PanelSpec } from './layout';

const p = (id: string, collapsed = false, weight?: number): PanelSpec => ({ id, collapsed, weight });
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('layoutPanels', () => {
  it('expanded panels share the height equally by default, summing to the available space', () => {
    const h = layoutPanels(701, [p('a'), p('b'), p('c')]);
    expect(sum(h)).toBe(701);
    expect(Math.max(...h) - Math.min(...h)).toBeLessThanOrEqual(2);
  });

  it('a collapsed panel is its header, in place; the others share what is left', () => {
    const h = layoutPanels(500, [p('a'), p('b', true), p('c'), p('d', true)]);
    expect(h[1]).toBe(HEADER_H);
    expect(h[3]).toBe(HEADER_H);
    expect(h[0] + h[2]).toBe(500 - 2 * HEADER_H);
  });

  it('trailing collapsed panels dock at the bottom: the expanded one fills everything above them', () => {
    const h = layoutPanels(500, [p('a'), p('b', true), p('c', true)]);
    expect(h).toEqual([500 - 2 * HEADER_H, HEADER_H, HEADER_H]);
  });

  it('shares in proportion to the saved heights', () => {
    expect(layoutPanels(600, [p('a', false, 300), p('b', false, 100)])).toEqual([450, 150]);
  });

  it('a panel with no saved height takes the average of the saved ones', () => {
    const h = layoutPanels(600, [p('a', false, 300), p('b', false, 100), p('c')]);
    expect(h[2]).toBeGreaterThan(h[1]);
    expect(h[2]).toBeLessThan(h[0]);
  });

  it('no expanded panel goes under the minimum; the others give the space', () => {
    expect(layoutPanels(500, [p('a', false, 1000), p('b', false, 1)])).toEqual([500 - MIN_PANEL_H, MIN_PANEL_H]);
  });

  it('when even the minimums do not fit, the expanded panels shrink evenly so the stack still fits (K56)', () => {
    const h = layoutPanels(200, [p('a'), p('b'), p('c', true)]);
    expect(h).toEqual([87, 87, HEADER_H]);
    expect(h.reduce((a, b) => a + b, 0)).toBe(200);
  });

  it('all collapsed: only headers', () => {
    expect(layoutPanels(500, [p('a', true), p('b', true)])).toEqual([HEADER_H, HEADER_H]);
  });
});

describe('dividerTargets', () => {
  it('each expanded panel trades with the next expanded one below it, skipping collapsed ones', () => {
    expect(dividerTargets([p('a'), p('b', true), p('c'), p('d', true), p('e')])).toEqual([2, null, 4, null, null]);
  });
  it('the last expanded panel has no divider', () => {
    expect(dividerTargets([p('a'), p('b', true)])).toEqual([null, null]);
  });
});

describe('resizePair', () => {
  it('moves height from one neighbour to the other, keeping the total', () => {
    expect(resizePair(200, 200, 50)).toEqual([250, 150]);
    expect(resizePair(200, 200, -50)).toEqual([150, 250]);
  });
  it('clamps at the minimum on both sides', () => {
    expect(resizePair(200, 200, 1000)).toEqual([400 - MIN_PANEL_H, MIN_PANEL_H]);
    expect(resizePair(200, 200, -1000)).toEqual([MIN_PANEL_H, 400 - MIN_PANEL_H]);
  });
  it('does not move a pair already at the limit', () => {
    expect(resizePair(MIN_PANEL_H, 300, -40)).toEqual([MIN_PANEL_H, 300]);
  });
});

describe('tree indent (K61)', () => {
  it('a folder and a leaf at the same depth share the icon x; a child icon sits under its parent name', () => {
    expect(rowIndent(1)).toBe(ROW_PAD);
    const parentNameX = rowIndent(2 - 1) + ICON_W + ROW_GAP;
    expect(rowIndent(2)).toBe(parentNameX);
    expect(rowIndent(3) - rowIndent(2)).toBe(INDENT_STEP);
  });
});
