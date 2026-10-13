import { describe, expect, it, vi } from 'vitest';
import { canvasMeasure, columnCount, displayCell, MAX_CH, measureColumns, MIN_CH, SAMPLE_ROWS, type Measure } from './columns';

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

describe('measureColumns with a measure (proportional text)', () => {
  // Capitals 1.5 ch, everything else 1; the header (bold) a tenth wider; monospace 1.2 ch a character.
  const calls: string[] = [];
  const measure: Measure = (text, bold, mono) => {
    calls.push(text);
    if (mono) return text.length * 1.2;
    const w = [...text].reduce((a, ch) => a + (/[A-Z]/.test(ch) ? 1.5 : 1), 0);
    return bold ? w * 1.1 : w;
  };

  it('fits each column to its widest value as shown, header included', () => {
    const cols = measureColumns(['id', 'elevation_m', 'name'], [['ST01', '4', 'Port Wren'], ['ST02', '812', 'Hollow Ridge']], measure);
    // ST01: 2 capitals and 2 digits; elevation_m in bold monospace (a numeric column); Hollow Ridge: 2 capitals.
    expect(cols.map((c) => c.ch)).toEqual([5, 13.2, 13]);
    expect(cols[1].numeric).toBe(true);
  });

  it('keeps MIN_CH and MAX_CH, and rounds up to a tenth', () => {
    const cols = measureColumns(['a', 'b'], [['x', 'W'.repeat(30)]], (t) => t.length * 1.4);
    expect(cols.map((c) => c.ch)).toEqual([MIN_CH, MAX_CH]);
    expect(measureColumns(['h'], [['abcd']], (t) => t.length * 1.01)[0].ch).toBe(4.1);
  });

  it("doesn't measure a cell too short to be wider than the widest so far", () => {
    calls.length = 0;
    measureColumns(['h'], [['a much longer cell than the rest'], ...Array.from({ length: 50 }, (_, i) => [`r${i}`])], measure);
    expect(calls).toEqual(['h', 'a much longer cell than the rest']);
  });
});

describe('canvasMeasure', () => {
  it("measures in the table's fonts, in ch of the regular text's 0", () => {
    const fonts: string[] = [];
    const ctx = {
      font: '',
      measureText(text: string) {
        fonts.push(this.font);
        return { width: text === '0' ? 8 : text.length * (this.font.startsWith('600') ? 10 : 9) };
      },
    };
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    document.documentElement.style.setProperty('--font-ui', 'Test Sans');
    try {
      const measure = canvasMeasure()!;
      expect(measure('ab', false, false)).toBe(18 / 8);
      expect(measure('ab', true, false)).toBe(20 / 8);
      expect(fonts).toEqual(['400 100px Test Sans', '400 100px Test Sans', '600 100px Test Sans']);
      measure('1', false, true);
      expect(ctx.font).toBe('400 100px monospace');
    } finally {
      spy.mockRestore();
      document.documentElement.style.removeProperty('--font-ui');
    }
  });
});
