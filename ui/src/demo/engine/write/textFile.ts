// Saving text into a worktree file as the core does (write/files.rs `encode`, `write_atomic`, and the
// §7.5 checks every save shares): in the file's loaded encoding, BOM and line endings, only over the
// bytes the editor loaded. The browser has no encoder for legacy multi-byte encodings (Shift_JIS,
// GBK, …): those refuse as text the encoding can't hold; single-byte ones encode through a table
// built from TextDecoder.
import type { Eol } from '../../../api/gen/Eol';
import { gbError } from '../errors';
import { blobId } from '../read/bytes';
import { AttrReader, worktreeEncoding } from '../read/attributes';
import { decodeBlob, type Decoded } from '../read/decode';
import { fail } from '../read/seam';
import { MODE_EXEC, MODE_FILE } from '../read/trees';
import { safeJoin } from '../read/worktree';
import type { WriteWt } from './seam';

export async function declaredEncoding(wt: WriteWt, path: string): Promise<string | null> {
  return worktreeEncoding(await new AttrReader(wt.repo, wt.root).get(path));
}

export const hasBom = (b: Uint8Array): boolean => (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);

const MULTI_BYTE = new Set(['gbk', 'gb18030', 'big5', 'euc-jp', 'iso-2022-jp', 'shift_jis', 'euc-kr']);
const tables = new Map<string, Map<string, number>>();
/** windows-1252's 0x80–0x9F (the WHATWG index, as browsers decode them): Node 22's decoder reads these
 *  bytes as Latin-1, so the tests would build a wrong table from it. */
const CP1252_C1 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

/** A single-byte encoding's char → byte table, from its decoder (windows-1252's 0x80–0x9F from `CP1252_C1`). */
function tableOf(encoding: string): Map<string, number> | null {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    return null;
  }
  if (MULTI_BYTE.has(decoder.encoding)) return null;
  let t = tables.get(decoder.encoding);
  if (!t) {
    t = new Map();
    for (let b = 0; b < 256; b++) {
      const c = decoder.encoding === 'windows-1252' && b >= 0x80 && b < 0xa0 ? String.fromCharCode(CP1252_C1[b - 0x80]) : decoder.decode(Uint8Array.of(b));
      if (c !== '�' && !t.has(c)) t.set(c, b);
    }
    tables.set(decoder.encoding, t);
  }
  return t;
}

export function encode(text: string, encoding: string, eol: Eol, bom: boolean): Uint8Array {
  const t = eol === 'crlf' ? text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') : eol === 'lf' ? text.replaceAll('\r\n', '\n') : text;
  const bad = () => gbError('InvalidInput', `This text can't be saved as ${encoding}`);
  const utf16 = (le: boolean) => {
    const out: number[] = bom ? (le ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
    for (let i = 0; i < t.length; i++) {
      const u = t.charCodeAt(i);
      out.push(...(le ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]));
    }
    return Uint8Array.from(out);
  };
  switch (encoding) {
    case 'UTF-8':
      return new TextEncoder().encode(t);
    case 'UTF-8 BOM':
      return Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(t)]);
    case 'UTF-16LE':
      return utf16(true);
    case 'UTF-16BE':
      return utf16(false);
    case 'ISO-8859-1':
      return Uint8Array.from([...t].map((c) => (c.codePointAt(0)! < 256 ? c.codePointAt(0)! : (() => { throw bad(); })())));
    default: {
      const table = tableOf(encoding);
      if (!table) throw bad();
      return Uint8Array.from([...t].map((c) => table.get(c) ?? (() => { throw bad(); })()));
    }
  }
}

export interface LoadedText {
  bytes: Uint8Array;
  decoded: Decoded;
  bom: boolean;
  mode: number;
}

export async function loadForSave(wt: WriteWt, path: string, base: string | null, verb: 'edit' | 'resolve'): Promise<LoadedText> {
  const abs = await safeJoin(wt.repo, wt.root, path);
  let st;
  try {
    st = wt.fs.lstatSync(abs);
  } catch {
    throw gbError('Stale', `${path} changed on disk`);
  }
  if (!st.isFile()) fail('InvalidInput', `${path} isn't a regular file: ${verb} it in your editor`);
  if ((st.mode & 0o200) === 0) fail('InvalidInput', `${path} is read-only: make it writable first`);
  const bytes = wt.fs.readFileSync(abs) as Uint8Array;
  if (base !== (await blobId(bytes))) throw gbError('Stale', `${path} changed on disk`);
  const decoded = decodeBlob(bytes, await declaredEncoding(wt, path));
  if (decoded.binary) fail('InvalidInput', `${path} is binary: ${verb} it in your editor`);
  return { bytes, decoded, bom: hasBom(bytes), mode: st.mode & 0o111 ? MODE_EXEC : MODE_FILE };
}
