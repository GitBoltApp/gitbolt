import { isNumeric } from './csv';

/** A column's width in characters, from its content: at least MIN_CH, at most MAX_CH (a longer
 * cell is cut off with an ellipsis; selecting it still copies the whole text). */
export const MIN_CH = 3;
export const MAX_CH = 40;
/** Rows looked at for widths and alignment: the first ones, and as many from the end. */
export const SAMPLE_ROWS = 500;

export interface Column {
  /** Width in `ch`. */
  ch: number;
  /** Every sampled cell that isn't empty is a number: right-aligned, monospace. */
  numeric: boolean;
}

function sample<T>(rows: T[]): T[] {
  return rows.length <= SAMPLE_ROWS * 2 ? rows : [...rows.slice(0, SAMPLE_ROWS), ...rows.slice(-SAMPLE_ROWS)];
}

/** A cell's width on its one line, in characters, up to MAX_CH (a longer cell isn't scanned:
 * its breaks shown as one glyph each can't bring it under MAX_CH). */
const cellChars = (cell: string): number => {
  if (cell.length >= 2 * MAX_CH) return MAX_CH;
  if (!cell.includes('\n') && !cell.includes('\r')) return cell.length;
  // A multi-line cell shows on one line, its breaks as one glyph each (`displayCell`).
  return displayCell(cell).length;
};

/** A cell's text as it shows on its one line: each line break is a ↵. */
export const displayCell = (cell: string): string => cell.replace(/\r\n|\r|\n/g, '↵');

/** How many columns `header` and `rows` have: as many as the widest row. */
export function columnCount(header: string[], rows: string[][]): number {
  let count = header.length;
  for (const r of rows) if (r.length > count) count = r.length;
  return count;
}

/** A text's width on its one line, in `ch` of the table's regular text (its "0"): `bold` the
 * header, `mono` a numeric column. */
export type Measure = (text: string, bold: boolean, mono: boolean) => number;

/** One `ch` a character: a monospace font's widths, and the measure without a canvas. */
export const charMeasure: Measure = (text) => text.length;

/** The widest a glyph is, in `ch` (a wide capital, CJK, an emoji): a cell this many times shorter
 * than the widest measured so far can't be wider, so it isn't measured. */
const WIDEST_GLYPH_CH = 2.5;
/** The most cells of a column measured, the longest first: bounds the work on a wide sample. */
const MEASURED_CELLS = 100;

/** The columns of `header` and `rows` (`columnCount`): widths and alignment from the header and
 * a sample of rows (SAMPLE_ROWS from each end), so the work is bounded by the columns. `measure`:
 * how wide a text shows (`canvasMeasure`); one `ch` a character without it. */
export function measureColumns(header: string[], rows: string[][], measure: Measure = charMeasure): Column[] {
  const some = sample(rows);
  const count = columnCount(header, rows);
  const widest = measure === charMeasure ? 1 : WIDEST_GLYPH_CH;
  const cols: Column[] = [];
  for (let c = 0; c < count; c++) {
    let numbers = 0;
    let text = 0;
    let capped = false;
    const cells = new Map<string, number>();
    for (const r of some) {
      const cell = r[c] ?? '';
      if (cell === '') continue;
      if (isNumeric(cell)) numbers++;
      else text++;
      const chars = cellChars(cell);
      if (chars >= MAX_CH && widest === 1) capped = true;
      else if (cell.length >= 2 * MAX_CH) capped = true;
      else cells.set(cell, chars);
    }
    const numeric = numbers > 0 && text === 0;
    const head = header[c] ?? '';
    let ch = capped || head.length >= 2 * MAX_CH ? MAX_CH : measure(displayCell(head), true, numeric);
    // The longest cells first, until the rest are too short to be any wider.
    const longest = [...cells].sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < longest.length && i < MEASURED_CELLS && ch < MAX_CH; i++) {
      const [cell, chars] = longest[i]!;
      if (chars * widest <= ch) break;
      ch = Math.max(ch, measure(displayCell(cell), false, numeric));
    }
    // Up to a tenth, so a measured width never comes out a hair short (an ellipsis).
    cols.push({ ch: Math.min(MAX_CH, Math.max(MIN_CH, Math.ceil(ch * 10 - 1e-6) / 10)), numeric });
  }
  return cols;
}

let ctx: CanvasRenderingContext2D | null | undefined;
let ctxFont = '';

/** The table's real text widths, from a canvas in the fonts it shows (the `--font-ui` and
 * `--font-mono` tokens, the header at weight 600, as table.css), at a size large enough that
 * rounding doesn't count: a width in `ch` is the same at every text size. Null without a canvas. */
export function canvasMeasure(): Measure | null {
  if (ctx === undefined) {
    try { ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d'); } catch { ctx = null; }
  }
  const canvas = ctx;
  if (!canvas) return null;
  const root = getComputedStyle(document.documentElement);
  const ui = root.getPropertyValue('--font-ui').trim() || 'sans-serif';
  const mono = root.getPropertyValue('--font-mono').trim() || 'monospace';
  const fontOf = (bold: boolean, isMono: boolean) => `${bold ? 600 : 400} 100px ${isMono ? mono : ui}`;
  // Setting the font parses it: only on a change (the canvas normalizes what it reads back).
  const setFont = (font: string) => { if (font !== ctxFont) { canvas.font = font; ctxFont = font; } };
  setFont(fontOf(false, false));
  const unit = canvas.measureText('0').width;
  if (!(unit > 0)) return null;
  return (text, bold, isMono) => {
    setFont(fontOf(bold, isMono));
    return canvas.measureText(text).width / unit;
  };
}
