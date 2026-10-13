import { describe, expect, it } from 'vitest';
import { asciiLower, base64, blobId, compareBytewise, decodeText, isBinaryHead, latin1, lossyUtf8, strictUtf8, utf8Bytes } from './bytes';

describe('bytes', () => {
  it('keeps every byte as one Latin-1 char', () => {
    expect(latin1(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]))).toBe('café\r\n');
    expect(latin1(new Uint8Array(100_000).fill(0x41)).length).toBe(100_000);
  });

  it('encodes base64 like the core', () => {
    expect(base64(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('iVBORw==');
  });

  it('decodes UTF-8 strictly, else as Latin-1', () => {
    expect(strictUtf8(utf8Bytes('héllo'))).toBe('héllo');
    expect(strictUtf8(new Uint8Array([0x63, 0xe9]))).toBeNull();
    expect(decodeText(new Uint8Array([0x63, 0xe9]))).toBe('cé');
    expect(lossyUtf8(new Uint8Array([0x63, 0xe9]))).toBe('c�');
  });

  it('gives blob ids as git hash-object does', async () => {
    expect(await blobId(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(await blobId(utf8Bytes('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('sniffs binary from a NUL in the first 8000 bytes only', () => {
    expect(isBinaryHead(new Uint8Array([0x42, 0, 0x43]))).toBe(true);
    const late = new Uint8Array(9000).fill(0x41);
    late[8500] = 0;
    expect(isBinaryHead(late)).toBe(false);
  });

  it('orders bytewise, as Rust orders UTF-8', () => {
    // U+FF5E (BMP) sorts before U+1F600 (astral) in UTF-8, though its UTF-16 unit is larger.
    expect(compareBytewise('～', '\u{1f600}')).toBeLessThan(0);
    expect(['b', 'a/x', 'a.txt', 'A', 'dir with space/ünï.txt'].sort(compareBytewise)).toEqual(['A', 'a.txt', 'a/x', 'b', 'dir with space/ünï.txt']);
    expect(compareBytewise('ab', 'abc')).toBeLessThan(0);
    expect(compareBytewise('same', 'same')).toBe(0);
  });

  it('lowercases ASCII only', () => {
    expect(asciiLower('README Été')).toBe('readme Été');
  });
});
