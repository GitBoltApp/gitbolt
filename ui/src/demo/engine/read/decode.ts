import type { Eol } from '../../../api/gen/Eol';
import { isBinaryHead, latin1, strictUtf8 } from './bytes';

export interface Decoded {
  text: string | null;
  binary: boolean;
  encoding: string;
  eol: Eol;
}

/** The WHATWG encoding names (encoding_rs's `name()`); `TextDecoder.encoding` gives them lower-cased. */
const NAMES = ['UTF-8', 'IBM866', 'ISO-8859-2', 'ISO-8859-3', 'ISO-8859-4', 'ISO-8859-5', 'ISO-8859-6', 'ISO-8859-7', 'ISO-8859-8', 'ISO-8859-8-I', 'ISO-8859-10', 'ISO-8859-13', 'ISO-8859-14', 'ISO-8859-15', 'ISO-8859-16', 'KOI8-R', 'KOI8-U', 'macintosh', 'windows-874', 'windows-1250', 'windows-1251', 'windows-1252', 'windows-1253', 'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257', 'windows-1258', 'x-mac-cyrillic', 'GBK', 'gb18030', 'Big5', 'EUC-JP', 'ISO-2022-JP', 'Shift_JIS', 'EUC-KR', 'UTF-16BE', 'UTF-16LE', 'x-user-defined'];
const CANONICAL = new Map(NAMES.map((n) => [n.toLowerCase(), n]));

function declaredDecoder(declared: string | null): TextDecoder | null {
  if (declared === null) return null;
  try {
    const d = new TextDecoder(declared.trim(), { ignoreBOM: true });
    return d.encoding === 'utf-8' ? null : d;
  } catch {
    return null;
  }
}

function textResult(text: string, encoding: string): Decoded {
  return { text, binary: false, encoding, eol: detectEol(text) };
}

export function decodeBlob(bytes: Uint8Array, declared: string | null): Decoded {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return textResult(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3)), 'UTF-8 BOM');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return textResult(new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes.subarray(2)), 'UTF-16LE');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return textResult(new TextDecoder('utf-16be', { ignoreBOM: true }).decode(bytes.subarray(2)), 'UTF-16BE');
  const d = declaredDecoder(declared);
  if (d) return textResult(d.decode(bytes), CANONICAL.get(d.encoding) ?? d.encoding);
  if (isBinaryHead(bytes)) return { text: null, binary: true, encoding: '', eol: 'none' };
  const utf8 = strictUtf8(bytes);
  return utf8 !== null ? textResult(utf8, 'UTF-8') : textResult(latin1(bytes), 'ISO-8859-1');
}

/** `is_binary_head`: no BOM, no declared non-UTF-8 encoding, and a NUL among the first 8000 bytes. */
export function isBinaryDeclared(head: Uint8Array, declared: string | null): boolean {
  const bom = (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) || (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  if (bom || declaredDecoder(declared)) return false;
  return isBinaryHead(head);
}

export function detectEol(text: string): Eol {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  if (crlf === 0 && lf === 0) return 'none';
  if (crlf === 0) return 'lf';
  if (lf === 0) return 'crlf';
  return 'mixed';
}

export function eolOnlyChange(a: string, b: string): boolean {
  return a !== b && a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');
}

/** `hexdump -C` lines without its `*` squeezing or closing offset line. */
export function hexLines(bytes: Uint8Array): string {
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
  const out: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const line = bytes.subarray(off, off + 16);
    let s = `${hex(off, 8)}  `;
    for (let j = 0; j < 16; j++) {
      s += j < line.length ? `${hex(line[j], 2)} ` : '   ';
      if (j === 7) s += ' ';
    }
    s += ' |';
    for (const b of line) s += (b >= 0x21 && b <= 0x7e) || b === 0x20 ? String.fromCharCode(b) : '.';
    out.push(`${s}|\n`);
  }
  return out.join('');
}
