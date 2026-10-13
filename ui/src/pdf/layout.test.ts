import { describe, expect, it } from 'vitest';
import { canvasRatio, columnHeight, currentPage, fitWidthScale, MAX_CANVAS_PIXELS, PAGE_GAP, pageAt, pageTops, syncedScrollTop, visiblePages } from './layout';

const letter = { w: 612, h: 792 };
const a4 = { w: 595, h: 842 };

describe('pdf layout', () => {
  it('stacks pages with a gap above each and below the last', () => {
    expect(pageTops([letter, letter], 1)).toEqual([PAGE_GAP, PAGE_GAP + 792 + PAGE_GAP]);
    expect(pageTops([letter], 0.5)).toEqual([PAGE_GAP]);
    expect(columnHeight([letter, letter], 0.5)).toBe(PAGE_GAP + 2 * (396 + PAGE_GAP));
  });

  it('finds the page at a point and the one being read', () => {
    const tops = pageTops([letter, letter, letter], 1);
    expect(pageAt(tops, 0)).toBe(0);
    expect(pageAt(tops, tops[1])).toBe(1);
    expect(pageAt(tops, tops[1] - 1)).toBe(0);
    expect(pageAt(tops, 1e9)).toBe(2);
    expect(currentPage(tops, tops[1] - 100, 600)).toBe(1);
    expect(currentPage([], 0, 600)).toBe(0);
  });

  it('lines the other side up page for page', () => {
    const same = { sizes: [letter, letter, letter], scale: 1 };
    // The same pages: the same position.
    expect(syncedScrollTop(same, same, 0)).toBe(0);
    expect(syncedScrollTop(same, same, 900)).toBeCloseTo(900);
    // Half way down page 2 of letter → half way down page 2 of A4.
    const tall = { sizes: [a4, a4, a4], scale: 1 };
    const mid = pageTops(same.sizes, 1)[1] - PAGE_GAP + (792 + PAGE_GAP) / 2;
    expect(syncedScrollTop(same, tall, mid)).toBeCloseTo(pageTops(tall.sizes, 1)[1] - PAGE_GAP + (842 + PAGE_GAP) / 2);
    // Past the other side's last page: its end.
    const short = { sizes: [letter], scale: 1 };
    expect(syncedScrollTop(same, short, pageTops(same.sizes, 1)[2])).toBe(columnHeight(short.sizes, 1));
    expect(syncedScrollTop(same, { sizes: [], scale: 1 }, 500)).toBe(0);
  });

  it('draws only the pages near the view', () => {
    const pages = Array.from({ length: 20 }, () => letter);
    expect(visiblePages(pages, 1, 0, 600)).toEqual([0, 1]);
    const tops = pageTops(pages, 1);
    expect(visiblePages(pages, 1, tops[10], 600)).toEqual([9, 10, 11]);
    expect(visiblePages(pages, 0.05, 0, 600).length).toBe(20);
    expect(visiblePages([], 1, 0, 600)).toEqual([]);
  });

  it('fits the widest page in the pane', () => {
    expect(fitWidthScale([letter, { w: 1224, h: 792 }], 1224 + 2 * PAGE_GAP)).toBe(1);
    expect(fitWidthScale([letter], 306 + 2 * PAGE_GAP)).toBe(0.5);
    expect(fitWidthScale([], 500)).toBe(1);
    expect(fitWidthScale([letter], 0)).toBe(1);
    // Within the zoom ladder: a narrow page in a wide pane stops at 1000%, a wide one at 10%.
    expect(fitWidthScale([{ w: 20, h: 20 }], 4000)).toBe(10);
    expect(fitWidthScale([{ w: 20000, h: 20 }], 500)).toBe(0.1);
  });

  it('caps a page canvas at 16 megapixels, stretched to the page', () => {
    expect(canvasRatio(letter, 1, 2)).toBe(2);
    // A letter page at 1000% on a 2× screen would be ~194 MP: drawn at a lower ratio.
    const r = canvasRatio(letter, 10, 2);
    expect(r).toBeLessThan(2);
    expect(letter.w * 10 * r * letter.h * 10 * r).toBeCloseTo(MAX_CANVAS_PIXELS, -2);
    expect(canvasRatio({ w: 0, h: 0 }, 1, 2)).toBe(2);
  });
});
