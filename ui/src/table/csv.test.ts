import { describe, expect, it } from 'vitest';
import { fileTableOf, MAX_COLUMNS, TOO_MANY_COLUMNS, MAX_LAYOUT_PX, maxGridRows, rowHeight, TABLE_MAX_CHARS, TABLE_TOO_LARGE, tooManyRows } from './limits';
import { CACHE_MAX_CHARS, delimiterOf, forgetTable, isNumeric, isTableCached, LARGE_TABLE_CHARS, parseDelimited, parseTable, tableDelimiterOf } from './csv';

const csv = (text: string) => parseDelimited(text, ',');

describe('parseDelimited (RFC 4180)', () => {
  it('splits rows at line breaks and cells at the delimiter; a final line break starts no row', () => {
    expect(csv('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(csv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('takes CRLF, LF and a lone CR as row ends', () => {
    expect(csv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(csv('a,b\r1,2\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('keeps empty cells, at the ends of a row too', () => {
    expect(csv(',a,,\n')).toEqual([['', 'a', '', '']]);
  });

  it('keeps an empty line as a row of one empty cell', () => {
    expect(csv('a\n\nb\n')).toEqual([['a'], [''], ['b']]);
  });

  it('a quoted field holds delimiters, line breaks (LF and CRLF) and doubled quotes', () => {
    expect(csv('"a,b","say ""hi""","line 1\nline 2","x\r\ny"\n')).toEqual([['a,b', 'say "hi"', 'line 1\nline 2', 'x\r\ny']]);
    expect(csv('"",""""\n')).toEqual([['', '"']]);
  });

  it('is lenient: a quote inside an unquoted field is text, text after a closing quote joins the field, an unclosed quote runs to the end', () => {
    expect(csv('5" pipe,ok\n')).toEqual([['5" pipe', 'ok']]);
    expect(csv('"quoted" tail,b\n')).toEqual([['quoted tail', 'b']]);
    expect(csv('a,"open\nstill,open')).toEqual([['a', 'open\nstill,open']]);
  });

  it('tolerates ragged rows', () => {
    expect(csv('a,b,c\n1\n1,2,3,4\n')).toEqual([['a', 'b', 'c'], ['1'], ['1', '2', '3', '4']]);
  });

  it('drops a leading BOM', () => {
    expect(csv('﻿id,name\n1,x\n')).toEqual([['id', 'name'], ['1', 'x']]);
    expect(csv('﻿')).toEqual([]);
    expect(csv('')).toEqual([]);
  });

  it('splits TSV at tabs, with the same quoting, and leaves commas alone', () => {
    expect(parseDelimited('a\tb,c\r\n"x\ty"\t2\n', '\t')).toEqual([['a', 'b,c'], ['x\ty', '2']]);
  });
});

describe('parseDelimited: maxRows', () => {
  it('stops after that many rows', () => {
    expect(csv('a\nb\nc\nd\n')).toHaveLength(4);
    expect(parseDelimited('a\nb\nc\nd\n', ',', 2)).toEqual([['a'], ['b']]);
    expect(parseDelimited('"x\ny"\nb\n', ',', 1)).toEqual([['x\ny']]);
  });
});

describe('fileTableOf', () => {
  it("is the table while the grid's height fits Chromium's layout limit; past it, the source with a note, at that text size", () => {
    const most = maxGridRows(rowHeight(13));
    expect((most + 1) * rowHeight(13)).toBeLessThanOrEqual(MAX_LAYOUT_PX);
    const atCap = `h\n${'1\n'.repeat(most)}`;
    expect(fileTableOf(atCap, ',', 13).table?.rows).toHaveLength(most);
    const over = `${atCap}1\n`;
    expect(fileTableOf(over, ',', 13)).toEqual({ table: null, note: tooManyRows(most) });
    expect(tooManyRows(most)).toMatch(/^Over 1,\d{3},\d{3} rows/);
    // A smaller text size fits more rows.
    expect(fileTableOf(over, ',', 8).table).not.toBeNull();
  });

  it(`is the source with a note over ${MAX_COLUMNS} columns`, () => {
    const row = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`).join(',');
    expect(fileTableOf(`${row(MAX_COLUMNS)}\n1\n`, ',', 13).table).not.toBeNull();
    expect(fileTableOf(`h\n${row(MAX_COLUMNS + 1)}\n`, ',', 13)).toEqual({ table: null, note: TOO_MANY_COLUMNS });
  });

  it('is the source with a note over 8 MB, unparsed', () => {
    expect(fileTableOf(`h\n${'x'.repeat(TABLE_MAX_CHARS)}`, ',', 13)).toEqual({ table: null, note: TABLE_TOO_LARGE });
  });
});

describe('delimiterOf', () => {
  it('is a comma for .csv and a tab for .tsv, by extension in any case; null for anything else', () => {
    expect(delimiterOf('data/people.csv')).toBe(',');
    expect(delimiterOf('DATA.TSV')).toBe('\t');
    expect(delimiterOf('notes.txt')).toBeNull();
    expect(delimiterOf('.csv')).toBeNull();
    expect(delimiterOf('csv/readme')).toBeNull();
  });

  it("a diff's is the new path's, else the old one's", () => {
    expect(tableDelimiterOf({ path: 'a.tsv', oldPath: 'a.csv' })).toBe('\t');
    expect(tableDelimiterOf({ path: 'a.txt', oldPath: 'a.csv' })).toBe(',');
    expect(tableDelimiterOf({ path: 'a.txt', oldPath: null })).toBeNull();
  });
});

describe('isNumeric', () => {
  it.each(['0', '-12', '+3.5', '.5', '1,234,567.89', '6.02e23', '1E-3', '45%', ' 7 '])('%s is a number', (s) => expect(isNumeric(s)).toBe(true));
  it.each(['', 'abc', '1.2.3', '12a', '-', '.', '1,23', '0x1F', 'e5'])('%s is not', (s) => expect(isNumeric(s)).toBe(false));
});

describe('parseTable', () => {
  it('keeps the last two parses only, and none of a text over 8 MB', () => {
    const texts = ['a\n1\n', 'b\n2\n', 'c\n3\n'];
    for (const t of texts) parseTable(t, ',');
    expect(texts.map(isTableCached)).toEqual([false, true, true]);
    const huge = `h\n${'x'.repeat(CACHE_MAX_CHARS)}\n`;
    const t = parseTable(huge, ',');
    expect(isTableCached(huge)).toBe(false);
    expect(parseTable(huge, ',')).not.toBe(t);
  });

  it("forgets a large text's parse when its view goes, and leaves a small one", () => {
    const large = `h\n${'x,'.repeat(LARGE_TABLE_CHARS / 2)}\n`;
    const small = 'h\n1\n';
    parseTable(large, ',');
    parseTable(small, ',');
    forgetTable(large);
    forgetTable(small);
    expect(isTableCached(large)).toBe(false);
    expect(isTableCached(small)).toBe(true);
  });


  it('with maxRows, stops past that many rows under the header and says so', () => {
    const text = 'h\n1\n2\n3\n';
    expect(parseTable(text, ',', 3)).toEqual({ header: ['h'], rows: [['1'], ['2'], ['3']] });
    expect(parseTable(text, ',', 2)).toEqual({ header: ['h'], rows: [['1'], ['2']], truncated: true });
    const other = 'h\n4\n5\n6\n';
    expect(parseTable(other, ',', 1)).toEqual({ header: ['h'], rows: [['4']], truncated: true });
    // A cut parse never stands in for a full one.
    expect(parseTable(other, ',')).toEqual({ header: ['h'], rows: [['4'], ['5'], ['6']] });
  });

  it('takes the first row as the header, and returns the same table for the same text', () => {
    const t = parseTable('h1,h2\n1,2\n', ',');
    expect(t).toEqual({ header: ['h1', 'h2'], rows: [['1', '2']] });
    expect(parseTable('h1,h2\n1,2\n', ',')).toBe(t);
    expect(parseTable('h1,h2\n1,2\n', '\t')).not.toBe(t);
  });
});
