import { describe, expect, it } from 'vitest';
import { BAND_MAX_DEVICE_H, bandAt, bandCovers, bandOverscan } from './band';

describe('the canvas band (the drawn strip of content the graph canvas holds)', () => {
  it('reaches half a viewport above and below, in whole rows', () => {
    // 600 px viewport, 25 px rows: 12 rows of overscan either side.
    expect(bandOverscan(600, 25, 1)).toBe(300);
    // 610 px: rounded up to whole rows (13 rows).
    expect(bandOverscan(610, 25, 1)).toBe(325);
    const b = bandAt(5000, 600, 25, 1);
    expect(b).toEqual({ top: 5000 - 300, height: 600 + 2 * 300, overscan: 300 });
  });

  it('starts on a whole row: the scroll offset snapped down to its row, less the overscan', () => {
    // 5013 is inside row 200 (5000..5025).
    expect(bandAt(5013, 600, 25, 1).top).toBe(5000 - 300);
    expect(bandAt(5024.5, 600, 25, 1).top).toBe(5000 - 300);
    expect(bandAt(5025, 600, 25, 1).top).toBe(5025 - 300);
  });

  it('starts at the content top, never above it (and survives an elastic negative scroll)', () => {
    expect(bandAt(100, 600, 25, 1).top).toBe(0);
    expect(bandAt(-40, 600, 25, 1).top).toBe(0);
  });

  it('starts on the device pixel grid at a fractional dpr', () => {
    const top = bandAt(5013, 600, 28, 1.25).top;
    expect(Math.abs(top * 1.25 - Math.round(top * 1.25))).toBeLessThan(1e-9);
  });

  it('a fresh band always covers the viewport, so drawing it once is enough', () => {
    for (const rowH of [25, 28, 32]) {
      for (let s = 0; s < 4000; s += 7.5) expect(bandCovers(bandAt(s, 600, rowH, 1), s, 600)).toBe(true);
    }
  });

  it('needs no redraw until the viewport comes within half the overscan of an edge', () => {
    const b = bandAt(5000, 600, 25, 1); // 4700..5900, slack 150
    expect(bandCovers(b, 5000 + 149, 600)).toBe(true);
    expect(bandCovers(b, 5000 + 151, 600)).toBe(false);
    expect(bandCovers(b, 5000 - 149, 600)).toBe(true);
    expect(bandCovers(b, 5000 - 151, 600)).toBe(false);
  });

  it('at the content top, scrolling up (even elastically) never asks for a redraw', () => {
    const b = bandAt(0, 600, 25, 1);
    expect(bandCovers(b, 0, 600)).toBe(true);
    expect(bandCovers(b, -40, 600)).toBe(true);
    // 0..1200 drawn: down to a 450 px offset (its bottom 150 px from the band's).
    expect(bandCovers(b, 449, 600)).toBe(true);
    expect(bandCovers(b, 451, 600)).toBe(false);
  });

  it('keeps the backing store modest: a 4K viewport at dpr 2 stays within the cap, well under GPU texture limits', () => {
    for (const [vh, dpr] of [[1080, 2], [2160, 1], [2160, 2], [1440, 2], [1300, 3]]) {
      const b = bandAt(10_000, vh, 28, dpr);
      expect(Math.round(b.height * dpr)).toBeLessThanOrEqual(BAND_MAX_DEVICE_H);
      expect(bandCovers(b, 10_000, vh)).toBe(true);
    }
    expect(BAND_MAX_DEVICE_H).toBeLessThanOrEqual(8192);
  });

  it('a 1440 px viewport at dpr 2: twice the viewport (in whole rows), 5792 device px tall', () => {
    // 26 rows of 28 px (728) either side.
    expect(Math.round(bandAt(10_000, 1440, 28, 2).height * 2)).toBe((1440 + 2 * 728) * 2);
  });

  it('keeps at least two rows of overscan even when the viewport alone fills the cap', () => {
    expect(bandOverscan(5000, 28, 2)).toBe(56);
    expect(bandCovers(bandAt(10_013, 5000, 28, 2), 10_013, 5000)).toBe(true);
  });
});
