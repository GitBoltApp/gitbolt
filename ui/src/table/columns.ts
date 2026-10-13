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

/** The columns of `header` and `rows` (`columnCount`): widths and alignment from the header and
 * a sample of rows (SAMPLE_ROWS from each end), so the work is bounded by the columns. */
export function measureColumns(header: string[], rows: string[][]): Column[] {
  const some = sample(rows);
  const count = columnCount(header, rows);
  const cols: Column[] = [];
  for (let c = 0; c < count; c++) {
    let ch = cellChars(header[c] ?? '');
    let numbers = 0;
    let text = 0;
    for (const r of some) {
      const cell = r[c] ?? '';
      if (cell === '') continue;
      ch = Math.max(ch, cellChars(cell));
      if (isNumeric(cell)) numbers++;
      else text++;
    }
    cols.push({ ch: Math.min(MAX_CH, Math.max(MIN_CH, ch)), numeric: numbers > 0 && text === 0 });
  }
  return cols;
}
