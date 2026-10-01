import { describe, expect, it } from 'vitest';
import { STICKY_SCROLL_NOTE } from '../diff/editorSettings';
import { clampFetchInterval, SETTINGS } from './schema';

describe('settings schema', () => {
  it('has unique ids and a section and keywords for every setting', () => {
    expect(new Set(SETTINGS.map((s) => s.id)).size).toBe(SETTINGS.length);
    for (const s of SETTINGS) expect(s.label && s.section && s.keywords).toBeTruthy();
  });
  it("the sticky scroll tooltip is 1B's note, verbatim", () => {
    expect(SETTINGS.find((s) => s.id === 'stickyScroll')?.help).toBe(STICKY_SCROLL_NOTE);
  });
});

describe('clampFetchInterval', () => {
  it('keeps 0 (or less, or NaN) as off and clamps the rest to a minute..a day', () => {
    expect(clampFetchInterval(0)).toBe(0);
    expect(clampFetchInterval(-5)).toBe(0);
    expect(clampFetchInterval(Number.NaN)).toBe(0);
    expect(clampFetchInterval(1)).toBe(60);
    expect(clampFetchInterval(300)).toBe(300);
    expect(clampFetchInterval(10 ** 9)).toBe(86_400);
  });
});
