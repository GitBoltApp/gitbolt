import { describe, expect, it } from 'vitest';
import { formatSize } from './hex';
import { byteRange, byteRuns, changedRows, charText, dumpBytes, hexText, mergeBlocks, offsetLabel, runsIn, selectedBytes, stepChange } from './hexModel';

/** `hexdump -C` lines, as the core's `hex_lines` makes them. */
function dumpOf(bytes: number[]): string {
  let out = '';
  for (let at = 0; at < bytes.length; at += 16) {
    const row = bytes.slice(at, at + 16);
    let hex = '';
    for (let j = 0; j < 16; j++) hex += (j < row.length ? row[j].toString(16).padStart(2, '0') : '  ') + ' ' + (j === 7 ? ' ' : '');
    out += `${at.toString(16).padStart(8, '0')}  ${hex} |${row.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')}|\n`;
  }
  return out;
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const bytes = (n: number, f: (i: number) => number = (i) => i) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);

describe('hex view', () => {
  it('sizes read as bytes, then KB and MB with one decimal unless it is 0', () => {
    expect([0, 1, 6, 1023, 1024, 1229, 256 * 1024, 4.2 * 1024 * 1024].map(formatSize)).toEqual(['0 bytes', '1 byte', '6 bytes', '1023 bytes', '1 KB', '1.2 KB', '256 KB', '4.2 MB']);
  });

  it("reads the bytes back from the core's dump, its ASCII column dropped", () => {
    expect([...dumpBytes({ size: 12, shown: 12, dump: '00000000  48 65 6c 6c 6f 20 77 6f  72 6c 64 0a              |Hello world.|\n' })]).toEqual([...latin1('Hello world\n')]);
    const many = Array.from({ length: 40 }, (_, i) => (i * 37) & 0xff);
    expect([...dumpBytes({ size: 99, shown: 40, dump: dumpOf(many) })]).toEqual(many);
    expect(dumpBytes(null).length).toBe(0);
    // Not a dump: whatever parses, no more.
    expect(dumpBytes({ size: 9, shown: 9, dump: 'object old\n' }).length).toBe(0);
  });

  it('a hex row is bytes only, 16 per row, an extra space between the groups of 8; the text row their characters', () => {
    const b = latin1('Hello, binary world\x00\x01\x7f\x80!');
    expect(hexText(b).split('\n')).toEqual(['48 65 6c 6c 6f 2c 20 62  69 6e 61 72 79 20 77 6f', '72 6c 64 00 01 7f 80 21']);
    expect(charText(b).split('\n')).toEqual(['Hello, binary wo', 'rld....!']);
    // Padded to the other side's rows, so they line up.
    expect(hexText(b, 16, 4).split('\n')).toHaveLength(4);
    expect(charText(new Uint8Array(0), 16, 2)).toBe('\n');
    // A narrow view: 8 per row, the halves of 4 apart.
    expect(hexText(b, 8).split('\n')).toEqual(['48 65 6c 6c  6f 2c 20 62', '69 6e 61 72  79 20 77 6f', '72 6c 64 00  01 7f 80 21']);
    expect(charText(b, 8).split('\n')).toEqual(['Hello, b', 'inary wo', 'rld....!']);
  });

  it('the gutter shows each row offset as 8 hex digits, nothing on padding rows', () => {
    expect([1, 2, 17].map((n) => offsetLabel(n, 1000))).toEqual(['00000000', '00000010', '00000100']);
    expect(offsetLabel(3, 32)).toBe('');
    expect([1, 2, 3].map((n) => offsetLabel(n, 1000, 8))).toEqual(['00000000', '00000008', '00000010']);
  });

  it('a selection maps to the bytes it covers, in either pane, and back to cells', () => {
    // Hex: "48 65 6c …": columns 1-2 are byte 0, 4-5 byte 1; byte 8 starts at column 26.
    expect(selectedBytes('hex', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }, 100)).toEqual([0, 2]);
    expect(selectedBytes('hex', { startLine: 1, startColumn: 3, endLine: 1, endColumn: 4 }, 100)).toBeNull();
    expect(selectedBytes('hex', { startLine: 1, startColumn: 2, endLine: 2, endColumn: 2 }, 100)).toEqual([0, 17]);
    expect(selectedBytes('hex', { startLine: 1, startColumn: 25, endLine: 1, endColumn: 27 }, 100)).toEqual([8, 9]);
    expect(selectedBytes('text', { startLine: 2, startColumn: 3, endLine: 3, endColumn: 1 }, 100)).toEqual([18, 32]);
    expect(selectedBytes('text', { startLine: 1, startColumn: 1, endLine: 9, endColumn: 17 }, 20)).toEqual([0, 20]);
    expect(byteRange('hex', 0, 2)).toEqual({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 });
    expect(byteRange('hex', 8, 9)).toEqual({ startLine: 1, startColumn: 26, endLine: 1, endColumn: 28 });
    expect(byteRange('text', 18, 32)).toEqual({ startLine: 2, startColumn: 3, endLine: 2, endColumn: 17 });
    expect(byteRange('hex', 15, 17)).toEqual({ startLine: 1, startColumn: 47, endLine: 2, endColumn: 3 });
    // 8 per row: byte 4 starts at column 14 (after the gap), byte 9 is row 2's second.
    expect(selectedBytes('hex', { startLine: 1, startColumn: 14, endLine: 2, endColumn: 6 }, 100, 8)).toEqual([4, 10]);
    expect(byteRange('hex', 4, 10, 8)).toEqual({ startLine: 1, startColumn: 14, endLine: 2, endColumn: 6 });
    expect(byteRange('text', 4, 10, 8)).toEqual({ startLine: 1, startColumn: 5, endLine: 2, endColumn: 3 });
  });

  it('byte i against byte i: changed runs, then what one side has past the other', () => {
    const old = bytes(40);
    const neu = bytes(50, (i) => (i === 3 || i === 4 || i === 20 ? 0xff : i));
    expect(byteRuns(old, neu)).toEqual([{ start: 3, end: 5, kind: 'changed' }, { start: 20, end: 21, kind: 'changed' }, { start: 40, end: 50, kind: 'added' }]);
    expect(byteRuns(neu.subarray(0, 10), old)).toEqual([{ start: 3, end: 5, kind: 'changed' }, { start: 10, end: 40, kind: 'added' }]);
    expect(byteRuns(old, old.subarray(0, 30))).toEqual([{ start: 30, end: 40, kind: 'removed' }]);
    expect(byteRuns(old, old)).toEqual([]);
  });

  it('the runs around the viewport, clipped to it; scrollbar marks merged when close', () => {
    const runs = byteRuns(bytes(64), bytes(64, (i) => (i % 2 ? i : ~i)));
    expect(runs).toHaveLength(32);
    expect(runsIn(runs, 16, 32).map((r) => [r.start, r.end])).toEqual([[16, 17], [18, 19], [20, 21], [22, 23], [24, 25], [26, 27], [28, 29], [30, 31]]);
    expect(runsIn([{ start: 0, end: 100, kind: 'changed' }], 16, 32)).toEqual([{ start: 16, end: 32, kind: 'changed' }]);
    expect(runsIn(runs, 200, 300)).toEqual([]);
    expect(mergeBlocks([{ first: 1, last: 2 }, { first: 5, last: 5 }, { first: 20, last: 22 }], 3)).toEqual([{ first: 1, last: 5 }, { first: 20, last: 22 }]);
  });

  it('next and previous change step through blocks of changed rows, wrapping around', () => {
    const blocks = changedRows([{ start: 3, end: 5, kind: 'changed' }, { start: 20, end: 21, kind: 'changed' }, { start: 100, end: 120, kind: 'changed' }, { start: 160, end: 170, kind: 'added' }]);
    expect(blocks).toEqual([{ first: 1, last: 2 }, { first: 7, last: 8 }, { first: 11, last: 11 }]);
    expect(changedRows([{ start: 3, end: 5, kind: 'changed' }, { start: 20, end: 21, kind: 'changed' }], 8)).toEqual([{ first: 1, last: 1 }, { first: 3, last: 3 }]);
    expect(stepChange(blocks, 1, 'next')).toBe(1);
    expect(stepChange(blocks, 7, 'next')).toBe(2);
    expect(stepChange(blocks, 11, 'next')).toBe(0);
    expect(stepChange(blocks, 7, 'previous')).toBe(0);
    expect(stepChange(blocks, 1, 'previous')).toBe(2);
    expect(stepChange([], 1, 'next')).toBe(-1);
  });
});
