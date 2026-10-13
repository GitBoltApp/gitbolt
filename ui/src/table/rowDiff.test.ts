import { describe, expect, it } from 'vitest';
import { isTableCached, parseTable, toTable } from './csv';
import { TABLE_MAX_CHARS, TABLE_TOO_LARGE, TOO_MANY_COLUMNS } from './limits';
import { changedCells, diffTables, TABLE_DIFF_GAVE_UP, TABLE_DIFF_MAX_ROWS, TABLE_DIFF_TOO_LARGE, tableDiffOf, type DiffRow } from './rowDiff';

const t = (...rows: string[][]) => toTable(rows);
/** A row as `<kind> <old>/<new> <cells>`, its changed cells starred. */
const show = (r: DiffRow) => `${r.kind} ${r.old ?? '-'}/${r.new ?? '-'} ${r.cells.map((c, i) => (r.changed?.[i] ? `*${c}` : c)).join('|')}`;

describe('diffTables', () => {
  it('lines rows up: unchanged rows on both sides, numbered on each', () => {
    const d = diffTables(t(['h'], ['a'], ['b']), t(['h'], ['a'], ['b']))!;
    expect(d.rows.map(show)).toEqual(['same 1/1 a', 'same 2/2 b']);
    expect(d.changes).toEqual([]);
    expect(d.header).toEqual(['h']);
    expect(d.headerChanged).toBeNull();
  });

  it('shows a row added and a row removed, each at its place', () => {
    const d = diffTables(t(['id', 'v'], ['1', 'a'], ['2', 'b'], ['3', 'c']), t(['id', 'v'], ['1', 'a'], ['3', 'c'], ['4', 'd']))!;
    expect(d.rows.map(show)).toEqual(['same 1/1 1|a', 'removed 2/- 2|b', 'same 3/2 3|c', 'added -/3 4|d']);
    expect(d.changes).toEqual([1, 3]);
  });

  it('a changed row is its old row then its new one, the cells that changed marked on both', () => {
    const d = diffTables(t(['id', 'name', 'qty'], ['1', 'Ada', '3'], ['2', 'Bo', '4']), t(['id', 'name', 'qty'], ['1', 'Ada', '5'], ['2', 'Bo', '4']))!;
    expect(d.rows.map(show)).toEqual(['removed 1/- 1|Ada|*3', 'added -/1 1|Ada|*5', 'same 2/2 2|Bo|4']);
    expect(d.changes).toEqual([0]);
  });

  it("pairs a run's rows in order, and a row with nothing in common stays removed and added", () => {
    const d = diffTables(t(['k', 'v'], ['a', '1'], ['b', '2']), t(['k', 'v'], ['a', '9'], ['x', 'y'], ['c', '3']))!;
    expect(d.rows.map(show)).toEqual(['removed 1/- a|*1', 'added -/1 a|*9', 'removed 2/- b|2', 'added -/2 x|y', 'added -/3 c|3']);
  });

  it('never pairs one-cell rows: a changed value is a removed row and an added one', () => {
    const d = diffTables(t(['v'], ['a']), t(['v'], ['b']))!;
    expect(d.rows.map(show)).toEqual(['removed 1/- a', 'added -/1 b']);
  });

  it('a changed header marks its changed cells, and shows the old header as a removed row first', () => {
    const d = diffTables(t(['id', 'name'], ['1', 'a']), t(['id', 'label'], ['1', 'a']))!;
    expect(d.header).toEqual(['id', 'label']);
    expect(d.headerChanged).toEqual([false, true]);
    expect(d.rows[0]).toMatchObject({ kind: 'removed', header: true, cells: ['id', 'name'] });
    expect(d.rows.slice(1).map(show)).toEqual(['same 1/1 1|a']);
    expect(d.changes).toEqual([0]);
  });

  it('a ragged row that gained a cell is a change of that cell', () => {
    const d = diffTables(t(['a', 'b'], ['1']), t(['a', 'b'], ['1', '2']))!;
    expect(d.rows.map(show)).toEqual(['removed 1/- 1', 'added -/1 1|*2']);
  });

  it('an added file is all added rows under its header; a deleted one, all removed under the old header', () => {
    expect(diffTables(t(), t(['h'], ['a']))!.rows.map(show)).toEqual(['added -/1 a']);
    const gone = diffTables(t(['h'], ['a']), t())!;
    expect(gone.header).toEqual(['h']);
    expect(gone.headerChanged).toBeNull();
    expect(gone.rows.map(show)).toEqual(['removed 1/- a']);
  });

  it('gives up (null) when lining up runs out of time', () => {
    expect(diffTables(t(['h'], ['a']), t(['h'], ['b']), -1)).toBeNull();
  });
});

describe('changedCells', () => {
  it('compares as many cells as the longer row, a missing cell as empty', () => {
    expect(changedCells(['a', 'b', ''], ['a', 'c'])).toEqual([false, true, false]);
  });
});

describe('tableDiffOf', () => {
  it('parses both texts and lines them up', () => {
    const r = tableDiffOf('h\na\n', 'h\nb\n', ',');
    expect(r.note).toBeNull();
    expect(r.diff!.rows.map(show)).toEqual(['removed 1/- a', 'added -/1 b']);
  });

  it(`is the source diff, with a note, over ${TABLE_DIFF_MAX_ROWS} rows a side`, () => {
    const big = `h\n${'1\n'.repeat(TABLE_DIFF_MAX_ROWS + 1)}`;
    expect(tableDiffOf('h\n1\n', big, ',')).toEqual({ diff: null, note: TABLE_DIFF_TOO_LARGE });
    const atCap = `h\n${'1\n'.repeat(TABLE_DIFF_MAX_ROWS)}`;
    expect(tableDiffOf(atCap, atCap, ',').note).toBeNull();
    expect(TABLE_DIFF_GAVE_UP).toMatch(/source diff/);
  });

  it('stops parsing a side at the cap', () => {
    const big = `h\n${'1\n'.repeat(TABLE_DIFF_MAX_ROWS * 3)}`;
    expect(tableDiffOf(big, big, ',').note).toBe(TABLE_DIFF_TOO_LARGE);
    expect(parseTable(big, ',', TABLE_DIFF_MAX_ROWS)).toMatchObject({ truncated: true });
    expect(parseTable(big, ',', TABLE_DIFF_MAX_ROWS).rows).toHaveLength(TABLE_DIFF_MAX_ROWS);
  });

  it('is the source diff, with a note, for a side over 500 columns', () => {
    const wide = `${Array.from({ length: 501 }, (_, i) => `c${i}`).join(',')}\n`;
    expect(tableDiffOf('h\n', wide, ',')).toEqual({ diff: null, note: TOO_MANY_COLUMNS });
  });

  it('is the source diff, with a note, for a side over 8 MB, without parsing it', () => {
    const huge = `h\n${'x'.repeat(TABLE_MAX_CHARS)}\n`;
    expect(tableDiffOf('only\n', huge, ',')).toEqual({ diff: null, note: TABLE_TOO_LARGE });
    expect(isTableCached('only\n')).toBe(false);
  });
});
