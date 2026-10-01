import { describe, expect, it } from 'vitest';
import { anchoredScrollTop } from './anchor';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe('anchoredScrollTop', () => {
  it('keeps the anchor row where it was when rows are inserted above it', () => {
    expect(anchoredScrollTop(rows('a', 'b', 'c'), rows('x', 'y', 'a', 'b', 'c'), 'b', 100, 25)).toBe(150);
  });
  it('uses the density row height it is given', () => {
    expect(anchoredScrollTop(rows('a', 'b'), rows('x', 'a', 'b'), 'b', 10, 28)).toBe(38);
  });
  it('at the very top, stays at the top: rows inserted above (a new row-0 WIP, K37) show', () => {
    expect(anchoredScrollTop(rows('a', 'b'), rows('x', 'a', 'b'), 'a', 0, 28)).toBe(0);
    expect(anchoredScrollTop(rows('a', 'b'), rows('x', 'y', 'a', 'b'), 'b', 0.5, 25)).toBe(0.5);
  });
  it('leaves the scroll alone without an anchor, or when the anchor disappeared', () => {
    expect(anchoredScrollTop(rows('a'), rows('b', 'a'), null, 40, 25)).toBe(40);
    expect(anchoredScrollTop(rows('a', 'b'), rows('c'), 'a', 40, 25)).toBe(40);
  });
  it('never goes negative', () => {
    expect(anchoredScrollTop(rows('x', 'y', 'a'), rows('a'), 'a', 10, 25)).toBe(0);
  });
});
