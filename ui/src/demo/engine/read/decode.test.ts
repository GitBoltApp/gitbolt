import { describe, expect, it } from 'vitest';
import { decodeBlob, detectEol, eolOnlyChange, hexLines, isBinaryDeclared } from './decode';

const utf16le = (s: string) => {
  const out = [0xff, 0xfe];
  for (const u of s.split('').map((c) => c.charCodeAt(0))) out.push(u & 0xff, u >> 8);
  return new Uint8Array(out);
};

describe('decode', () => {
  it('decodes BOMs, declared encodings, UTF-8 and Latin-1, and flags binary', () => {
    expect(decodeBlob(utf16le('héllo\r\n'), null)).toEqual({ text: 'héllo\r\n', binary: false, encoding: 'UTF-16LE', eol: 'crlf' });
    expect(decodeBlob(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65, 0x0a]), null)).toEqual({ text: 'café crème\n', binary: false, encoding: 'ISO-8859-1', eol: 'lf' });
    expect(decodeBlob(new Uint8Array([0x78, 0, 0x79]), null)).toEqual({ text: null, binary: true, encoding: '', eol: 'none' });
    expect(decodeBlob(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]), null)).toMatchObject({ text: 'hi\n', encoding: 'UTF-8 BOM' });
    expect(decodeBlob(utf16le('hi\n').subarray(2), 'UTF-16LE')).toMatchObject({ text: 'hi\n', encoding: 'UTF-16LE' });
    expect(decodeBlob(new Uint8Array([0x83, 0x65]), 'Shift_JIS')).toMatchObject({ encoding: 'Shift_JIS' });
    expect(decodeBlob(new TextEncoder().encode('plain\n'), 'utf-8')).toMatchObject({ encoding: 'UTF-8' });
    expect(isBinaryDeclared(new Uint8Array([0x41, 0, 0x42]), 'UTF-16LE')).toBe(false);
    expect(isBinaryDeclared(new Uint8Array([0x41, 0, 0x42]), null)).toBe(true);
  });

  it('detects line endings', () => {
    expect([detectEol('a\r\nb\n'), detectEol('no newline'), detectEol('a\nb\n'), detectEol('a\r\n')]).toEqual(['mixed', 'none', 'lf', 'crlf']);
    expect(eolOnlyChange('a\r\nb\r\n', 'a\nb\n')).toBe(true);
    expect(eolOnlyChange('a\nb\n', 'a\nb\n')).toBe(false);
    expect(eolOnlyChange('a\r\n', 'b\n')).toBe(false);
  });

  it('dumps hex like hexdump -C', () => {
    expect(hexLines(new TextEncoder().encode('Hello world\n'))).toBe('00000000  48 65 6c 6c 6f 20 77 6f  72 6c 64 0a              |Hello world.|\n');
    expect(hexLines(new Uint8Array(17).fill(0x41)).split('\n')[1]).toBe('00000010  41                                                |A|');
  });
});
