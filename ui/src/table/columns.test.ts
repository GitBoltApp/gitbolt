import { describe, expect, it } from 'vitest';
import { columnCount, displayCell, MAX_CH, measureColumns, MIN_CH, SAMPLE_ROWS } from './columns';

describe('measureColumns', () => {
  it('sizes each column to its longest cell or header, within MIN_CH and MAX_CH', () => {
    const cols = measureColumns(['id', 'name', 'notes'], [['1', 'Ada', 'x'.repeat(100)], ['22', 'Bartholomew', '']]);
    expect(cols.map((c) => c.ch)).toEqual([MIN_CH, 'Bartholomew'.length, MAX_CH]);
  });

  it('has as many columns as the widest row (ragged rows)', () => {
    expect(measureColumns(['a'], [['1', '2', '3'], []])).toHaveLength(3);
  });

  it('a column is numeric when every cell that isn\'t empty is a number', () => {
    const cols = measureColumns(['qty', 'code', 'blank'], [['1', '7', ''], ['', 'A7', ''], ['2,000.5', '8', '']]);
    expect(cols.map((c) => c.numeric)).toEqual([true, false, false]);
  });

  it('looks at a sample of a long file: its first and last rows', () => {
    const rows = Array.from({ length: SAMPLE_ROWS * 4 }, () => ['1']);
    rows[SAMPLE_ROWS * 2] = ['a long cell in the middle'];
    rows[rows.length - 1] = ['the last row\'s cell'];
    const [col] = measureColumns(['h'], rows);
    expect(col.ch).toBe('the last row\'s cell'.length);
    expect(col.numeric).toBe(false);
  });

  it('counts the widest row, and caps a long cell without measuring it', () => {
    expect(columnCount(['a'], [['1', '2'], ['1', '2', '3']])).toBe(3);
    expect(measureColumns(['h'], [['x'.repeat(1_000_000)]])[0].ch).toBe(MAX_CH);
    expect(measureColumns(['h'], [['\n'.repeat(2 * MAX_CH - 1)]])[0].ch).toBe(MAX_CH);
  });

  it('measures a multi-line cell as it shows: on one line, each break a ↵', () => {
    expect(displayCell('a\r\nb\nc\rd')).toBe('a↵b↵c↵d');
    expect(measureColumns(['h'], [['abcd\r\nefgh']])[0].ch).toBe(9);
  });
});
