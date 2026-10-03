import { describe, expect, it } from 'vitest';
import { compactRelativeTime, relativeTime } from './relative';

describe('relativeTime', () => {
  it('formats past times', () => {
    expect(relativeTime(1000 - 3 * 86_400, 1000)).toBe('3 days ago');
    expect(relativeTime(1000 - 30, 1000)).toBe('just now');
    expect(relativeTime(1000 - 7200, 1000)).toBe('2 hours ago');
  });
});

describe('compactRelativeTime', () => {
  const now = 100_000_000;
  const ago = (secs: number) => compactRelativeTime(now - secs, now);

  it('is "now" under a minute, then each unit from its first whole one (rounded like relativeTime)', () => {
    expect(ago(0)).toBe('now');
    expect(ago(59)).toBe('now');
    expect(ago(60)).toBe('1m');
    expect(ago(5 * 60)).toBe('5m');
    expect(ago(3599)).toBe('60m');
    expect(ago(3600)).toBe('1h');
    expect(ago(3 * 3600)).toBe('3h');
    expect(ago(86_399)).toBe('24h');
    expect(ago(86_400)).toBe('1d');
    expect(ago(2 * 86_400)).toBe('2d');
    expect(ago(604_799)).toBe('7d');
    expect(ago(604_800)).toBe('1w');
    expect(ago(3 * 604_800)).toBe('3w');
    expect(ago(2_591_999)).toBe('4w');
    expect(ago(2_592_000)).toBe('1mo');
    expect(ago(9 * 2_592_000)).toBe('9mo');
    expect(ago(31_535_999)).toBe('12mo');
    expect(ago(31_536_000)).toBe('1y');
    expect(ago(2 * 31_536_000)).toBe('2y');
  });

  it('rounds half up, and a time ahead (clock skew) reads as its distance', () => {
    expect(ago(89 * 60)).toBe('1h');
    expect(ago(90 * 60)).toBe('2h');
    expect(compactRelativeTime(now + 3 * 3600, now)).toBe('3h');
    expect(compactRelativeTime(now + 30, now)).toBe('now');
  });
});
