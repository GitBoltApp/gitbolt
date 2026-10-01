import { describe, expect, it } from 'vitest';
import { dropIndex } from './useTabDrag';

describe('dropIndex', () => {
  const mids = [50, 150, 250, 350];
  it('counts the other tabs whose centre is left of the pointer', () => {
    expect(dropIndex(mids, 0, 200)).toBe(1);
    expect(dropIndex(mids, 0, 400)).toBe(3);
    expect(dropIndex(mids, 3, 10)).toBe(0);
    expect(dropIndex(mids, 2, 260)).toBe(2);
  });
});
