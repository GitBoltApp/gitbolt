import { useMemo } from 'react';
import { canvasMeasure, charMeasure, measureColumns } from './columns';
import { useForgetTables, type Table } from './csv';
import type { TableDiff } from './rowDiff';
import { TableGrid, type GridRow } from './TableGrid';

const digits = (n: number) => Math.max(2, String(n).length);

/** File View's table of a CSV or TSV file (`table`, parsed from `text`): the first row its header. */
export function CsvTable({ text, table, fontPx }: { text: string; table: Table; fontPx: number }) {
  useForgetTables(text);
  const columns = useMemo(() => measureColumns(table.header, table.rows, canvasMeasure() ?? charMeasure), [table]);
  const rows = useMemo<GridRow[]>(() => table.rows.map((cells, i) => ({ cells, nums: [i + 1] })), [table]);
  return <TableGrid header={table.header} rows={rows} columns={columns} fontPx={fontPx} gutter={[digits(rows.length)]} label="Table" />;
}

/** Diff View's table diff: rows lined up, the old and new row numbers in the gutter. */
export function CsvTableDiff({ diff, fontPx }: { diff: TableDiff; fontPx: number }) {
  const columns = useMemo(() => measureColumns(diff.header, diff.rows.map((r) => r.cells), canvasMeasure() ?? charMeasure), [diff]);
  const rows = useMemo<GridRow[]>(() => diff.rows.map((r) => ({
    cells: r.cells,
    nums: [r.old, r.new],
    kind: r.kind === 'same' ? undefined : r.kind,
    changed: r.changed,
    header: r.header,
  })), [diff]);
  const most = diff.rows.reduce((m, r) => Math.max(m, r.old ?? 0, r.new ?? 0), 0);
  return <TableGrid header={diff.header} headerChanged={diff.headerChanged} rows={rows} columns={columns} fontPx={fontPx} gutter={[digits(most), digits(most)]} changes={diff.changes} label="Table diff" />;
}
