import { afterEach, describe, expect, it, vi } from 'vitest';
import { overBytes } from './limits';

afterEach(() => vi.restoreAllMocks());

describe('overBytes', () => {
  it('counts UTF-8 bytes as TextEncoder does: 1 to 3 per unit, 4 per surrogate pair, 3 for a lone one', () => {
    for (const text of ['abc', 'é'.repeat(10), '€'.repeat(10), '😀'.repeat(10), 'a\uD800b', `${'x'.repeat(7)}😀é€`]) {
      const bytes = new TextEncoder().encode(text).length;
      expect(overBytes(text, bytes)).toBe(false);
      expect(overBytes(text, bytes - 1)).toBe(true);
    }
  });

  it('decides from the length when it can, and counts a text once', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    expect(overBytes('x'.repeat(11), 10)).toBe(true);
    expect(overBytes('x'.repeat(3), 10)).toBe(false);
    const body = 'é'.repeat(4_000); // 8,000 bytes: the length can't tell against 10,000
    const count = vi.spyOn(String.prototype, 'charCodeAt');
    expect(overBytes(body, 10_000)).toBe(false);
    const counted = count.mock.calls.length;
    expect(counted).toBeGreaterThanOrEqual(4_000);
    expect(overBytes(body, 10_000)).toBe(false);
    expect(overBytes(body, 7_999)).toBe(true);
    expect(count.mock.calls.length).toBe(counted);
    expect(encode).not.toHaveBeenCalled();
  });
});
