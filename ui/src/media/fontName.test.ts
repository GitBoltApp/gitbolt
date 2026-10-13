import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { fontName, readNames } from './fontName';

type Rec = [platform: number, language: number, id: number, text: string];

/** A `name` table: Macintosh strings as Latin-1, the rest UTF-16BE. */
function nameTable(records: Rec[]): Uint8Array {
  const strings = records.map(([platform, , , text]) => (platform === 1 ? Uint8Array.from(text, (c) => c.charCodeAt(0)) : Uint8Array.from([...text].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff]))));
  const head = 6 + records.length * 12;
  const out = new Uint8Array(head + strings.reduce((n, s) => n + s.length, 0));
  const v = new DataView(out.buffer);
  v.setUint16(2, records.length);
  v.setUint16(4, head);
  let at = 0;
  records.forEach(([platform, language, id], i) => {
    const r = 6 + i * 12;
    [platform, platform === 3 ? 1 : 0, language, id, strings[i].length, at].forEach((x, k) => v.setUint16(r + k * 2, x));
    out.set(strings[i], head + at);
    at += strings[i].length;
  });
  return out;
}

const setTag = (v: DataView, at: number, tag: string) => [...tag].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));

function sfnt(name: Uint8Array, version = 0x00010000): Uint8Array {
  const out = new Uint8Array(12 + 16 + name.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, version);
  v.setUint16(4, 1);
  setTag(v, 12, 'name');
  v.setUint32(20, 28);
  v.setUint32(24, name.length);
  out.set(name, 28);
  return out;
}

function woff(name: Uint8Array, compress: boolean, stated = name.length): Uint8Array {
  const data = compress ? new Uint8Array(deflateSync(name)) : name;
  const out = new Uint8Array(44 + 20 + data.length);
  const v = new DataView(out.buffer);
  setTag(v, 0, 'wOFF');
  v.setUint32(4, 0x00010000);
  v.setUint16(12, 1);
  setTag(v, 44, 'name');
  v.setUint32(48, 64);
  v.setUint32(52, data.length);
  v.setUint32(56, stated);
  out.set(data, 64);
  return out;
}

describe('fontName', () => {
  it("reads a TrueType font's family and style, the Windows English names first", async () => {
    const table = nameTable([[1, 0, 1, 'Mac Family'], [3, 0x40c, 1, 'Famille'], [3, 0x409, 1, 'Fictive Sans'], [3, 0x409, 2, 'Bold Italic']]);
    expect(await fontName(sfnt(table))).toEqual({ family: 'Fictive Sans', style: 'Bold Italic' });
  });

  it('prefers the typographic family and subfamily (ids 16, 17), and reads Macintosh names when that is all there is', async () => {
    const typo = nameTable([[3, 0x409, 1, 'Fictive Sans Light'], [3, 0x409, 2, 'Regular'], [3, 0x409, 16, 'Fictive Sans'], [3, 0x409, 17, 'Light']]);
    expect(await fontName(sfnt(typo, 0x4f54544f /* OTTO */))).toEqual({ family: 'Fictive Sans', style: 'Light' });
    expect(await fontName(sfnt(nameTable([[1, 0, 1, 'Old Mac'], [1, 0, 2, 'Plain']])))).toEqual({ family: 'Old Mac', style: 'Plain' });
  });

  it('reads a WOFF name table, stored or zlib-packed', async () => {
    const table = nameTable([[3, 0x409, 1, 'Fictive Serif'], [3, 0x409, 2, 'Regular']]);
    expect(await fontName(woff(table, false))).toEqual({ family: 'Fictive Serif', style: 'Regular' });
    expect(await fontName(woff(table, true))).toEqual({ family: 'Fictive Serif', style: 'Regular' });
  });

  it('stops unpacking a WOFF name table past its stated size, or past 1 MiB (a zip bomb of zeros)', async () => {
    // A readable table, then 16 MiB of zeros: whole, it would name the font.
    const table = nameTable([[3, 0x409, 1, 'Bomb']]);
    const bomb = new Uint8Array(table.length + 16 * 1024 * 1024);
    bomb.set(table);
    expect(await fontName(woff(bomb, true, table.length))).toBeNull();
    expect(await fontName(woff(bomb, true, 0xffffffff))).toBeNull();
    expect(await fontName(woff(bomb.subarray(0, 64 * 1024), true))).toEqual({ family: 'Bomb', style: '' });
  });

  it('decodes each name once: 65,535 records at one blank string stay fast; a name over 1 KB is skipped', () => {
    // A string can only start in the first 128 KB (two 16-bit offsets), so it lies among the
    // records: the first 100 are spaces (a platform no name is read from), the 1,000 bytes the
    // other 65,435 point at (Macintosh, Latin-1: 1,000 spaces).
    const filler = 100;
    const table = new Uint8Array(6 + 65535 * 12);
    const v = new DataView(table.buffer);
    v.setUint16(2, 65535);
    v.setUint16(4, 6);
    table.fill(0x20, 6, 6 + filler * 12);
    for (let i = filler; i < 65535; i++) [1, 0, 0, 1, 1000, 0].forEach((x, k) => v.setUint16(6 + i * 12 + k * 2, x));
    const decodes = vi.spyOn(String, 'fromCharCode');
    const started = performance.now();
    expect(readNames(table)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
    expect(decodes).toHaveBeenCalledTimes(1);
    decodes.mockRestore();
    const long = nameTable([[3, 0x409, 1, 'x'.repeat(600)], [1, 0, 1, 'Short']]);
    expect(readNames(long.subarray(0))).toEqual({ family: 'Short', style: '' });
  });

  it("is null for WOFF2 (one Brotli stream), anything that isn't a font, and a truncated file", async () => {
    expect(await fontName(Uint8Array.from('wOF2\0\x01\0\0', (c) => c.charCodeAt(0)))).toBeNull();
    expect(await fontName(new TextEncoder().encode('not a font at all'))).toBeNull();
    expect(await fontName(sfnt(nameTable([[3, 0x409, 1, 'Cut']])).subarray(0, 30))).toBeNull();
    expect(await fontName(sfnt(nameTable([[3, 0x409, 2, 'Style only']])))).toBeNull();
  });
});
