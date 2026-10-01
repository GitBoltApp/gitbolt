import { describe, expect, it } from 'vitest';
import { CHIP_SPACING, CONNECTOR_MIN, fitCount, moreWidth } from './chipFit';

describe('fitCount', () => {
  const w = [80, 60, 70];
  it('shows every chip when they all fit with the connector floor', () => {
    expect(fitCount(w, 80 + 60 + 70 + 2 * CHIP_SPACING + CONNECTOR_MIN)).toBe(3);
    expect(fitCount(w, 1000)).toBe(3);
  });
  it('shows as many as fit beside +N when not all do', () => {
    expect(fitCount(w, 80 + 60 + CHIP_SPACING + moreWidth(1) + CONNECTOR_MIN)).toBe(2);
    expect(fitCount(w, 80 + 60 + CHIP_SPACING + moreWidth(1) + CONNECTOR_MIN - 1)).toBe(1);
  });
  it('always shows the first chip, even when it alone overflows', () => {
    expect(fitCount(w, 10)).toBe(1);
  });
  it('compact shows just the first; a lone or no chip is itself', () => {
    expect(fitCount(w, 1000, true)).toBe(1);
    expect(fitCount([50], 10)).toBe(1);
    expect(fitCount([], 10)).toBe(0);
  });
});
