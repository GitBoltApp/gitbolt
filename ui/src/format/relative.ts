const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]];
const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 days ago" from unix seconds. */
export function relativeTime(unixSeconds: number, now = Date.now() / 1000): string {
  const diff = unixSeconds - now;
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return fmt.format(Math.round(diff / secs), unit);
  }
  return 'just now';
}

const COMPACT: Partial<Record<Intl.RelativeTimeFormatUnit, string>> = { year: 'y', month: 'mo', week: 'w', day: 'd', hour: 'h', minute: 'm' };

/** `relativeTime`'s compact form, for narrow columns: "now", "5m", "3h", "2d", "3w", "9mo", "2y"
 * (same units and rounding; a time ahead of `now`, clock skew, reads as its distance). */
export function compactRelativeTime(unixSeconds: number, now = Date.now() / 1000): string {
  const diff = Math.abs(now - unixSeconds);
  for (const [unit, secs] of UNITS) {
    if (diff >= secs) return `${Math.round(diff / secs)}${COMPACT[unit]}`;
  }
  return 'now';
}
