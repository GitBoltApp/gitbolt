import { columnCount } from './columns';
import { parseTable, type Delimiter, type Table } from './csv';

/** Over this many characters (about 8 MB), a file shows its source rather than a table: the
 * parse runs on the main thread. */
export const TABLE_MAX_CHARS = 8 * 1024 * 1024;
export const TABLE_TOO_LARGE = 'Over 8 MB: the source shows instead of the table';

/** The row height for a text size: one line and its padding. */
export const rowHeight = (fontPx: number) => Math.ceil(fontPx * 1.75);

/** The tallest an element lays out in Chromium (LayoutUnit's limit, 2^31 / 64 px), less some
 * slack: a taller grid would cut its last rows off. */
export const MAX_LAYOUT_PX = 33_000_000;
/** The most rows a grid holds at `rowH` (its header is one more row). */
export const maxGridRows = (rowH: number) => Math.floor(MAX_LAYOUT_PX / rowH) - 1;
export const tooManyRows = (rows: number) => `Over ${rows.toLocaleString('en-US')} rows at this text size: the source shows instead of the table`;

/** Over this many columns, the source shows instead: every row renders all its cells. */
export const MAX_COLUMNS = 500;
export const TOO_MANY_COLUMNS = 'Over 500 columns: the source shows instead of the table';

/** File View's table of `text`, or why its source shows instead (`note`). */
export type FileTable = { table: Table; note: null } | { table: null; note: string };

/** `fontPx`: the text size, which sets the row height and so how many rows fit in a grid. */
export function fileTableOf(text: string, delimiter: Delimiter, fontPx: number): FileTable {
  if (text.length > TABLE_MAX_CHARS) return { table: null, note: TABLE_TOO_LARGE };
  const most = maxGridRows(rowHeight(fontPx));
  const table = parseTable(text, delimiter, most);
  if (table.truncated) return { table: null, note: tooManyRows(most) };
  if (columnCount(table.header, table.rows) > MAX_COLUMNS) return { table: null, note: TOO_MANY_COLUMNS };
  return { table, note: null };
}
