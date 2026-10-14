import { describe, expect, it } from 'vitest';
import { encode } from './textFile';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

describe('encode', () => {
  it('keeps the loaded encoding, BOM and line endings', () => {
    expect(hex(encode('a\nb\r\n', 'UTF-8', 'crlf', false))).toBe('61 0d 0a 62 0d 0a');
    expect(hex(encode('a\r\nb\n', 'UTF-8', 'lf', false))).toBe('61 0a 62 0a');
    expect(hex(encode('a\r\nb\n', 'UTF-8', 'mixed', false))).toBe('61 0d 0a 62 0a');
    expect(hex(encode('é', 'UTF-8 BOM', 'none', true))).toBe('ef bb bf c3 a9');
    expect(hex(encode('é', 'UTF-16LE', 'none', true))).toBe('ff fe e9 00');
    expect(hex(encode('é', 'UTF-16BE', 'none', false))).toBe('00 e9');
    expect(hex(encode('é€', 'windows-1252', 'none', false))).toBe('e9 80');
    expect(hex(encode('é', 'ISO-8859-1', 'none', false))).toBe('e9');
  });

  it("refuses text the encoding can't hold", () => {
    const thrown = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return null;
    };
    expect(thrown(() => encode('€', 'ISO-8859-1', 'none', false))).toMatchObject({ kind: 'InvalidInput', message: "This text can't be saved as ISO-8859-1" });
    expect(thrown(() => encode('日本', 'Shift_JIS', 'none', false))).toMatchObject({ message: "This text can't be saved as Shift_JIS" });
  });
});
