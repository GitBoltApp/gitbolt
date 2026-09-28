import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampSplit, loadSplit, saveSplit, SPLIT, splitBounds } from './detailsSplit';

describe('details split (feedback F13)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults to about 25 % header+message / 75 % files, and clamps to its range', () => {
    expect(SPLIT).toMatchObject({ default: 0.25, min: 0.1, max: 0.75, key: 'gitbolt.detailsSplit.v1' });
    expect(loadSplit()).toBe(0.25);
    expect(clampSplit(0.01)).toBe(SPLIT.min);
    expect(clampSplit(0.99)).toBe(SPLIT.max);
    expect(clampSplit(0.4)).toBe(0.4);
  });

  it('persists the ratio for the session in localStorage, ignoring bad values and storage errors', () => {
    saveSplit(0.4);
    expect(localStorage.getItem(SPLIT.key)).toBe('0.4');
    expect(loadSplit()).toBe(0.4);
    localStorage.setItem(SPLIT.key, 'nonsense');
    expect(loadSplit()).toBe(SPLIT.default);
    localStorage.setItem(SPLIT.key, '5');
    expect(loadSplit()).toBe(SPLIT.max);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(loadSplit()).toBe(SPLIT.default);
    expect(() => saveSplit(0.3)).not.toThrow();
  });

  it('keeps the header plus a few message lines above, and a usable file list below', () => {
    // 800 px panel, 100 px header: at least header + message minimum on top, SPLIT.bottomPx below.
    const [min, max] = splitBounds(800, 100);
    expect(min).toBeCloseTo((100 + SPLIT.topExtraPx) / 800);
    expect(max).toBeCloseTo(Math.min(SPLIT.max, 1 - SPLIT.bottomPx / 800));
    // Unmeasured (0 px): the plain ratio range.
    expect(splitBounds(0, 0)).toEqual([SPLIT.min, SPLIT.max]);
    // A tall header in a short panel: never an empty range.
    const [lo, hi] = splitBounds(300, 250);
    expect(lo).toBeLessThanOrEqual(hi);
  });
});
