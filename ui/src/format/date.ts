import type { DateFormat } from '../api/gen/DateFormat';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local timestamp in the chosen preset (spec §8.4 Date column; `ymd12h` is the default). */
export function formatDate(unixSeconds: number, fmt: DateFormat = 'ymd12h'): string {
  const d = new Date(unixSeconds * 1000);
  const [y, mo, day, h, mi] = [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), d.getHours(), pad(d.getMinutes())];
  const h12 = `${h % 12 === 0 ? 12 : h % 12}:${mi} ${h < 12 ? 'AM' : 'PM'}`;
  switch (fmt) {
    case 'ymd24h': return `${y}-${mo}-${day} ${pad(h)}:${mi}`;
    case 'dmy24h': return `${day}/${mo}/${y} ${pad(h)}:${mi}`;
    case 'mdy12h': return `${mo}/${day}/${y} ${h12}`;
    default: return `${y}-${mo}-${day} @ ${h12}`;
  }
}
