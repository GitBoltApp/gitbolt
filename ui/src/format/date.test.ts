import { describe, expect, it } from 'vitest';
import { formatDate } from './date';

describe('formatDate', () => {
  // 2026-09-26 15:14 local time
  const t = new Date(2026, 8, 26, 15, 14).getTime() / 1000;
  it('formats every preset', () => {
    expect(formatDate(t)).toBe('2026-09-26 @ 3:14 PM');
    expect(formatDate(t, 'ymd12h')).toBe('2026-09-26 @ 3:14 PM');
    expect(formatDate(t, 'ymd24h')).toBe('2026-09-26 15:14');
    expect(formatDate(t, 'dmy24h')).toBe('26/09/2026 15:14');
    expect(formatDate(t, 'mdy12h')).toBe('09/26/2026 3:14 PM');
  });
  it('midnight and noon in 12-hour formats', () => {
    expect(formatDate(new Date(2026, 0, 2, 0, 5).getTime() / 1000)).toBe('2026-01-02 @ 12:05 AM');
    expect(formatDate(new Date(2026, 0, 2, 12, 0).getTime() / 1000, 'mdy12h')).toBe('01/02/2026 12:00 PM');
    expect(formatDate(new Date(2026, 0, 2, 0, 5).getTime() / 1000, 'ymd24h')).toBe('2026-01-02 00:05');
  });
});
