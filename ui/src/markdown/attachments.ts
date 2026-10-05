const ATTACHMENT = /https?:\/\/[^\s<>()"'\]]+?\/user-attachments\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const SIGNED = /(?:src|href)="(https?:\/\/[^"]+?[?&](?:amp;)?jwt=[^"]+)"/gi;
const unescape = (s: string) => s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** An inline code span: a backtick run to the next run of the same length, within a paragraph. */
const CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;

/** `body`'s code, as [start, end) ranges: fenced code blocks (to their closing fence, or the end),
 * then inline code spans outside them. */
function codeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fence: { ch: string; len: number; start: number } | null = null;
  let pos = 0;
  for (const line of body.split('\n')) {
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && line.slice(m[0].length).trim() === '') {
        ranges.push([fence.start, pos + line.length]);
        fence = null;
      }
    } else if (m && !(m[1]![0] === '`' && line.slice(m[0].length).includes('`'))) {
      fence = { ch: m[1]![0]!, len: m[1]!.length, start: pos };
    }
    pos += line.length + 1;
  }
  if (fence) ranges.push([fence.start, body.length]);
  // Spans, found with the fenced blocks blanked out (same offsets).
  let masked = body;
  for (const [s, e] of ranges) masked = masked.slice(0, s) + ' '.repeat(e - s) + masked.slice(e);
  for (const m of masked.matchAll(CODE_SPAN)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/** `body` with each GitHub `user-attachments` URL replaced by its signed, time-limited
 * `private-user-images` URL from `bodyHtml` (the `full` media type, spec §4.2): by the asset id
 * the signed URL carries, else in document order (ruling 6). Only URLs the renderer loads or links
 * change: never one inside code (a fenced block or an inline span), which shows as written.
 * Unchanged without a match. */
export function signedAttachments(body: string, bodyHtml: string | null | undefined): string {
  if (!bodyHtml || !body.includes('/user-attachments/assets/')) return body;
  const signed = [...new Set([...bodyHtml.matchAll(SIGNED)].map((m) => unescape(m[1]!)))];
  if (signed.length === 0) return body;
  const code = codeRanges(body);
  const inCode = (at: number) => code.some(([s, e]) => at >= s && at < e);
  const urls = [...new Set([...body.matchAll(ATTACHMENT)].filter((m) => !inCode(m.index)).map((m) => m[0]))];
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const url of urls) {
    const id = url.slice(-36).toLowerCase();
    const hit = signed.find((s) => !used.has(s) && s.toLowerCase().includes(id));
    if (hit) { map.set(url, hit); used.add(hit); }
  }
  const rest = signed.filter((s) => !used.has(s));
  urls.filter((u) => !map.has(u)).forEach((u, i) => { if (rest[i]) map.set(u, rest[i]); });
  return body.replace(ATTACHMENT, (whole: string, _id: string, at: number) => (inCode(at) ? whole : map.get(whole) ?? whole));
}
