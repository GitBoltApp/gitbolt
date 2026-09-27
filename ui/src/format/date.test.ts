import { describe, expect, it } from 'vitest';
import { formatDate } from './date';

describe('formatDate', () => {
  it('formats as YYYY-MM-DD @ h:mm AM/PM in local time', () => {
    const d = new Date(2026, 8, 26, 15, 14);
    expect(formatDate(d.getTime() / 1000)).toBe('2026-09-26 @ 3:14 PM');
  });
  it('handles midnight and noon', () => {
    expect(formatDate(new Date(2026, 0, 2, 0, 5).getTime() / 1000)).toBe('2026-01-02 @ 12:05 AM');
    expect(formatDate(new Date(2026, 0, 2, 12, 0).getTime() / 1000)).toBe('2026-01-02 @ 12:00 PM');
  });
});
