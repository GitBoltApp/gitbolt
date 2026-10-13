import { useEffect } from 'react';

/** The extensions File View can show as a table, and the delimiter each one uses. */
export const TABLE_DELIMITERS = { csv: ',', tsv: '\t' } as const;
export type Delimiter = (typeof TABLE_DELIMITERS)[keyof typeof TABLE_DELIMITERS];

/** The delimiter of a `.csv` or `.tsv` path; null for any other file. */
export function delimiterOf(path: string): Delimiter | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return ext === 'csv' || ext === 'tsv' ? TABLE_DELIMITERS[ext] : null;
}

/** A diff's delimiter: the new path's, else the old one's (a rename to or from a table name). */
export const tableDelimiterOf = (t: { path: string; oldPath: string | null }): Delimiter | null =>
  delimiterOf(t.path) ?? (t.oldPath !== null ? delimiterOf(t.oldPath) : null);

/**
 * Splits delimited text into rows of cells (RFC 4180): a quoted field holds delimiters, line
 * breaks and doubled quotes (`""`); rows end at CRLF, LF or a lone CR. Lenient where real files
 * are: a leading BOM is dropped, rows may have any number of cells, a quote inside an unquoted
 * field is kept as text, text after a closing quote joins the field, and an unclosed quote runs to
 * the end. A final line break doesn't start another row. TSV gets the same quoting (what
 * spreadsheets write). It stops after `maxRows` rows.
 */
export function parseDelimited(text: string, delimiter: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (i >= n) return rows;
  const d = delimiter.charCodeAt(0);
  let row: string[] = [];
  for (;;) {
    // One field, from `i`.
    let field: string;
    if (text.charCodeAt(i) === 34 /* " */) {
      let out = '';
      let from = ++i;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) { out += text.slice(from); i = n; break; }
        if (text.charCodeAt(q + 1) === 34) { out += text.slice(from, q + 1); i = from = q + 2; continue; }
        out += text.slice(from, q);
        i = q + 1;
        break;
      }
      // Anything up to the next delimiter or line break joins the field.
      const end = fieldEnd(text, i, d);
      field = out + text.slice(i, end);
      i = end;
    } else {
      const end = fieldEnd(text, i, d);
      field = text.slice(i, end);
      i = end;
    }
    row.push(field);
    if (i >= n) { rows.push(row); break; }
    const c = text.charCodeAt(i);
    if (c === d) { i++; continue; }
    // A line break: CRLF, LF or CR.
    rows.push(row);
    if (rows.length >= maxRows) break;
    row = [];
    i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    if (i >= n) break;
  }
  return rows;
}

/** Where the unquoted field from `i` ends: the next delimiter, CR or LF, or the end. */
function fieldEnd(text: string, i: number, d: number): number {
  const n = text.length;
  for (; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === d || c === 10 || c === 13) return i;
  }
  return n;
}

/** A cell that reads as a number: an integer, a decimal, an exponent, a sign, thousands
 * separators, a trailing percent. */
const NUMBER = /^[-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?%?$/;
export const isNumeric = (cell: string): boolean => NUMBER.test(cell.trim());

/** A parsed file: its header (the first row) and the rows under it. `truncated`: it has more
 * rows than were asked for (`parseTable`'s `maxRows`), and `rows` stops there. */
export interface Table { header: string[]; rows: string[][]; truncated?: boolean }

export function toTable(cells: string[][]): Table {
  return { header: cells[0] ?? [], rows: cells.slice(1) };
}

/** The last two parses, by delimiter and text (moving back and forth between two files, or a
 * diff's two sides). A text over CACHE_MAX_CHARS is never kept: its table lives as long as the
 * view showing it. */
const cache: { key: string; text: string; table: Table; limit: number }[] = [];
export const CACHE_SIZE = 2;
export const CACHE_MAX_CHARS = 8 * 1024 * 1024;
/** A view of a text over this many characters drops its parse when it goes (`forgetTable`). */
export const LARGE_TABLE_CHARS = 1024 * 1024;

/** `text` as a table. `maxRows`: it stops once the rows under the header pass this many, marked
 * `truncated` (a caller that won't show that many needn't parse them all). */
export function parseTable(text: string, delimiter: Delimiter, maxRows = Infinity): Table {
  const hit = cache.find((c) => c.key === delimiter && c.text === text && (!c.table.truncated || c.limit >= maxRows));
  if (hit) return hit.table.rows.length > maxRows && !hit.table.truncated ? { ...hit.table, rows: hit.table.rows.slice(0, maxRows), truncated: true } : hit.table;
  const cells = parseDelimited(text, delimiter, maxRows + 2);
  const table = toTable(cells);
  if (table.rows.length > maxRows) {
    table.rows.length = maxRows;
    table.truncated = true;
  }
  if (text.length <= CACHE_MAX_CHARS) {
    cache.unshift({ key: delimiter, text, table, limit: maxRows });
    cache.length = Math.min(cache.length, CACHE_SIZE);
  }
  return table;
}

/** Drops `text`'s parse from the cache, when it's large (`LARGE_TABLE_CHARS`): its view went. */
export function forgetTable(text: string): void {
  if (text.length <= LARGE_TABLE_CHARS) return;
  for (let i = cache.length - 1; i >= 0; i--) if (cache[i].text === text) cache.splice(i, 1);
}

/** Whether `text` has a parse in the cache (for tests). */
export const isTableCached = (text: string): boolean => cache.some((c) => c.text === text);

/** Drops a large text's parse when the view showing it goes, or shows another text. */
export function useForgetTables(...texts: string[]): void {
  useEffect(() => () => texts.forEach(forgetTable), texts); // eslint-disable-line react-hooks/exhaustive-deps
}
