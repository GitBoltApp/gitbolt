/**
 * A short key for a (possibly multi-MB) text: its length and two 32-bit FNV-1a-style hashes over
 * its UTF-16 code units (different offset bases and multipliers), in hex. Fast and not
 * cryptographic: for cache keys and "has this text changed" checks, where keeping or concatenating
 * the texts themselves would copy megabytes.
 */
export function textKey(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return `${text.length}:${(a >>> 0).toString(16)}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
