// A font's family and style from its `name` table: the FontFace API loads a font under the family
// we give it, and never says the one inside. TrueType/OpenType, and WOFF (its tables zlib-packed
// one by one). WOFF2 packs all its tables in one Brotli stream, which the webview can't unpack:
// no name for it.

export interface FontName { family: string; style: string }

const tag = (v: DataView, at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

/** The `name` table's bytes, or null (not a font we read, no such table, truncated). */
async function nameTable(bytes: Uint8Array): Promise<Uint8Array | null> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) return null;
  const sig = tag(v, 0);
  if (sig === 'wOFF') {
    if (bytes.length < 44) return null;
    const n = v.getUint16(12);
    for (let i = 0; i < n; i++) {
      const at = 44 + i * 20;
      if (at + 20 > bytes.length) return null;
      if (tag(v, at) !== 'name') continue;
      const [offset, comp, orig] = [v.getUint32(at + 4), v.getUint32(at + 8), v.getUint32(at + 12)];
      if (offset + comp > bytes.length) return null;
      const table = bytes.subarray(offset, offset + comp);
      return comp < orig ? inflate(table, Math.min(orig, MAX_NAME_TABLE)) : table;
    }
    return null;
  }
  if (sig !== 'OTTO' && sig !== 'true' && v.getUint32(0) !== 0x00010000) return null;
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    if (at + 16 > bytes.length) return null;
    if (tag(v, at) !== 'name') continue;
    const [offset, length] = [v.getUint32(at + 8), v.getUint32(at + 12)];
    return offset + length <= bytes.length ? bytes.subarray(offset, offset + length) : null;
  }
  return null;
}

/** A `name` table is a few KB; a packed one that unpacks past this (or past its stated size) is
 * hostile, and isn't unpacked further. */
const MAX_NAME_TABLE = 1024 * 1024;

/** `data` unpacked, or null past `limit` bytes (a zip bomb stops there) or when it isn't zlib. */
async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new DecompressionStream('deflate');
    const writer = stream.writable.getWriter();
    void writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => {});
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = stream.readable.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      total += r.value.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(r.value);
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
    return out;
  } catch {
    return null;
  }
}

/** Unicode (0) and Windows (3) names are UTF-16BE; Macintosh (1) Roman, read as Latin-1. */
function decode(platform: number, raw: Uint8Array): string {
  if (platform === 1) return String.fromCharCode(...raw);
  let s = '';
  for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
  return s;
}

/** A family or style name longer than this is no name to show. */
const MAX_NAME_BYTES = 1024;

/** Name ids 16/17 (typographic family, subfamily) over 1/2; Windows English over the rest. */
export function readNames(table: Uint8Array): FontName | null {
  if (table.length < 6) return null;
  const v = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const count = v.getUint16(2);
  const strings = v.getUint16(4);
  const found = new Map<number, { rank: number; text: string }>();
  // Each (id, rank) is decoded once, even when it came out empty: 65,535 records naming the same
  // blank string cost one decode, not 65,535.
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > table.length) break;
    const [platform, , language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((o) => v.getUint16(at + o));
    if (![1, 2, 16, 17].includes(id) || ![0, 1, 3].includes(platform) || length > MAX_NAME_BYTES) continue;
    const start = strings + offset;
    if (start + length > table.length) continue;
    const rank = platform === 3 ? (language === 0x409 ? 0 : 1) : platform === 0 ? 2 : 3;
    if (seen.has(id * 4 + rank)) continue;
    seen.add(id * 4 + rank);
    const prev = found.get(id);
    if (!prev || rank < prev.rank) {
      const text = decode(platform, table.subarray(start, start + length)).trim();
      if (text) found.set(id, { rank, text });
    }
  }
  const family = (found.get(16) ?? found.get(1))?.text;
  if (!family) return null;
  return { family, style: (found.get(17) ?? found.get(2))?.text ?? '' };
}

/** The font's own family and style, or null when they can't be read. */
export async function fontName(bytes: Uint8Array): Promise<FontName | null> {
  const table = await nameTable(bytes);
  return table ? readNames(table) : null;
}
