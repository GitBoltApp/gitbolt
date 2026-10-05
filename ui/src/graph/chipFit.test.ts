import { describe, expect, it } from 'vitest';
import { CHIP_PAD, CHIP_SPACING, CONNECTOR_MIN, chipWidth, fitCount, moreWidth } from './chipFit';

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

describe('chipWidth', () => {
  it('an icon-only chip (a crowded detached HEAD) is just its padding and icons, far narrower than with its name', () => {
    const head = { row: 0, name: 'HEAD', local: null, tag: false, isHead: true, worktree: null, checkedOut: null, remotes: [] };
    expect(chipWidth(head, '12px sans-serif', true)).toBe(CHIP_PAD + 16);
    expect(chipWidth(head, '12px sans-serif')).toBeGreaterThan(chipWidth(head, '12px sans-serif', true) + 20);
  });
  it("counts the upstream-name warning (UX round 3, M.1): the chip's width already holds it", () => {
    const branch = { row: 0, name: 'feature/a', local: 'refs/heads/feature/a', tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [] };
    expect(chipWidth({ ...branch, upstreamMismatch: 'origin/feature/b' }, '12px sans-serif')).toBe(chipWidth(branch, '12px sans-serif') + 12 + 3);
  });
  it('counts an MR/PR badge as one more icon, beside the local and remote ones', () => {
    const branch = { row: 0, name: 'feature/a', local: 'refs/heads/feature/a', tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [] };
    const plain = chipWidth(branch, '12px sans-serif');
    expect(chipWidth(branch, '12px sans-serif', false, true) - plain).toBeGreaterThanOrEqual(14);
  });
});
