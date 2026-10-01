import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative';

describe('relativeTime', () => {
  it('formats past times', () => {
    expect(relativeTime(1000 - 3 * 86_400, 1000)).toBe('3 days ago');
    expect(relativeTime(1000 - 30, 1000)).toBe('just now');
    expect(relativeTime(1000 - 7200, 1000)).toBe('2 hours ago');
  });
});
