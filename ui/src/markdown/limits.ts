/** Bodies up to this many characters (or already parsed) render in the first paint (ruling 2). */
export const SYNC_PARSE_CHARS = 16_384;
/** Above this many characters, a "Rendering…" line holds the place while it parses (spec §3.1). */
export const RENDERING_NOTE_CHARS = 500_000;
/** `MarkdownProps.maxBytes`'s default (spec §3.1: File View's 5 MB). */
export const DEFAULT_MAX_BYTES = 5_000_000;
/** The MR/PR view keeps plain text for bodies over 1 MB (spec §3.1). */
export const MR_BODY_MAX_BYTES = 1_000_000;

/** UTF-8 sizes of the recent texts whose length couldn't tell (a poll re-renders the same bodies). */
const SIZES_KEPT = 16;
const sizes = new Map<string, number>();

/** `text`'s UTF-8 size, counted without encoding a copy. */
function utf8Size(text: string): number {
  let n = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 2; i++; } // a pair: 4 bytes for 2 units
    else n += 2;
  }
  return n;
}

/** `text`'s UTF-8 size is over `max`: the length tells first (at most 3 bytes per UTF-16 unit),
 * else it's counted once per text and kept for the next render. */
export function overBytes(text: string, max: number): boolean {
  if (text.length > max) return true;
  if (text.length * 3 <= max) return false;
  let size = sizes.get(text);
  if (size === undefined) {
    size = utf8Size(text);
    sizes.set(text, size);
    if (sizes.size > SIZES_KEPT) sizes.delete(sizes.keys().next().value!);
  }
  return size > max;
}
