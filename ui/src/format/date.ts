const pad = (n: number) => String(n).padStart(2, '0');

/** Local timestamp: `2026-09-26 @ 3:14 PM`. */
export function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} @ ${h12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}
