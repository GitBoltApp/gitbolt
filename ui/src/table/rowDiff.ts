import { diffArrays } from 'diff';
import { parseTable, type Delimiter, type Table } from './csv';
import { columnCount } from './columns';
import { MAX_COLUMNS, TABLE_MAX_CHARS, TABLE_TOO_LARGE, TOO_MANY_COLUMNS } from './limits';

/** Over this many rows a side, Diff View shows the source diff instead of the table diff. */
export const TABLE_DIFF_MAX_ROWS = 50_000;
export const TABLE_DIFF_TOO_LARGE = 'Over 50,000 rows: the source diff shows instead';
/** Lining rows up that takes longer than this gives up, for the source diff. */
export const TABLE_DIFF_BUDGET_MS = 750;
export const TABLE_DIFF_GAVE_UP = 'Too many changes to line up by row: the source diff shows instead';

/** One row of the table diff. `old` / `new`: its 1-based row number on that side (the header
 * isn't counted). `changed`: on a removed row and the added row it became, which cells differ. */
export interface DiffRow {
  kind: 'same' | 'added' | 'removed';
  cells: string[];
  old: number | null;
  new: number | null;
  changed?: boolean[];
  /** The old header, removed (the new one is the table's header). */
  header?: true;
}

export interface TableDiff {
  header: string[];
  /** The header's cells that differ from the old header's; null when it didn't change. */
  headerChanged: boolean[] | null;
  rows: DiffRow[];
  /** Where each change starts: the index in `rows` of the first row of each run of changes. */
  changes: number[];
}

/** Why a table diff isn't shown (the source diff is), or null. */
export type TableDiffResult = { diff: TableDiff; note: null } | { diff: null; note: string };

const rowKey = (r: string[]) => `${r.length}\u0000${r.join('\u0000')}`;

/** Which cells differ between two rows (as many as the longer one). */
export function changedCells(a: string[], b: string[]): boolean[] {
  const n = Math.max(a.length, b.length);
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push((a[i] ?? '') !== (b[i] ?? ''));
  return out;
}

/** Whether a removed row and an added one are the same row changed (shown as a pair, its changed
 * cells marked) rather than one row gone and another new: a one-cell row never is; a wider one
 * when a cell that isn't empty is the same in both. */
function sameRow(a: string[], b: string[]): boolean {
  if (Math.max(a.length, b.length) < 2) return false;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== '' && a[i] === b[i]) return true;
  return false;
}

/**
 * Lines `old`'s rows up with `neu`'s (a row diff, as `diff` lines text up), the header apart: a
 * changed header marks its cells and shows the old one as a removed row first. Within a run of
 * changes, a removed row and the added row at the same place in the run that is the same row
 * changed (`sameRow`) show one above the other, their differing cells marked. Null when lining up
 * took over `budgetMs`.
 */
export function diffTables(old: Table, neu: Table, budgetMs = TABLE_DIFF_BUDGET_MS): TableDiff | null {
  const hasNew = neu.header.length > 0 || neu.rows.length > 0;
  const header = hasNew ? neu.header : old.header;
  const rows: DiffRow[] = [];
  let headerChanged: boolean[] | null = null;
  if (hasNew && old.header.length > 0 && rowKey(old.header) !== rowKey(neu.header)) {
    headerChanged = changedCells(old.header, neu.header);
    rows.push({ kind: 'removed', cells: old.header, old: null, new: null, changed: headerChanged, header: true });
  }
  // Rows as numbers (one per distinct row), which compare faster than their text.
  const ids = new Map<string, number>();
  const idOf = (r: string[]) => {
    const k = rowKey(r);
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    return id;
  };
  const parts = diffArrays(old.rows.map(idOf), neu.rows.map(idOf), { timeout: budgetMs });
  if (!parts) return null;
  let o = 0;
  let n = 0;
  let removed: number[] = [];
  let added: number[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      const r = removed[i];
      const a = added[i];
      const pair = r !== undefined && a !== undefined && sameRow(old.rows[r], neu.rows[a]);
      const changed = pair ? changedCells(old.rows[r], neu.rows[a]) : undefined;
      if (r !== undefined) rows.push({ kind: 'removed', cells: old.rows[r], old: r + 1, new: null, changed });
      if (a !== undefined) rows.push({ kind: 'added', cells: neu.rows[a], old: null, new: a + 1, changed });
    }
    removed = [];
    added = [];
  };
  for (const p of parts) {
    if (p.removed) { for (let i = 0; i < p.count; i++) removed.push(o++); continue; }
    if (p.added) { for (let i = 0; i < p.count; i++) added.push(n++); continue; }
    flush();
    for (let i = 0; i < p.count; i++, o++, n++) rows.push({ kind: 'same', cells: neu.rows[n], old: o + 1, new: n + 1 });
  }
  flush();
  const changes: number[] = [];
  rows.forEach((r, i) => { if (r.kind !== 'same' && (i === 0 || rows[i - 1].kind === 'same')) changes.push(i); });
  return { header, headerChanged, rows, changes };
}

/** The table diff of two texts, or why the source diff shows instead: a side over 8 MB or
 * TABLE_DIFF_MAX_ROWS, or rows that took too long to line up. */
export function tableDiffOf(old: string, neu: string, delimiter: Delimiter): TableDiffResult {
  if (old.length > TABLE_MAX_CHARS || neu.length > TABLE_MAX_CHARS) return { diff: null, note: TABLE_TOO_LARGE };
  // A side past the cap stops being parsed there.
  const a = parseTable(old, delimiter, TABLE_DIFF_MAX_ROWS);
  const b = parseTable(neu, delimiter, TABLE_DIFF_MAX_ROWS);
  if (a.truncated || b.truncated) return { diff: null, note: TABLE_DIFF_TOO_LARGE };
  if (columnCount(a.header, a.rows) > MAX_COLUMNS || columnCount(b.header, b.rows) > MAX_COLUMNS) return { diff: null, note: TOO_MANY_COLUMNS };
  const diff = diffTables(a, b);
  return diff ? { diff, note: null } : { diff: null, note: TABLE_DIFF_GAVE_UP };
}
