import { useVirtualizer } from '@tanstack/react-virtual';
import type { RulerKind, RulerMark } from '../diff/mdRuler';
import { RulerFrame } from '../diff/RulerFrame';
import { useEffect, useLayoutEffect, useMemo, useRef, type ClipboardEvent, type CSSProperties } from 'react';
import { openTop, revealTop, stepTarget, type ChangeBox } from '../diff/changeNav';
import { setChangeStepper, STEP_MARGIN, type StepDir } from '../diff/changeStepper';
import { displayCell, type Column } from './columns';
import { rowHeight } from './limits';
import './table.css';

/** A row of the grid: its cells, and in a diff, how it changed. `nums`: its row number(s) in the
 * gutter, one in File View, old and new in a diff (null: not on that side). */
export interface GridRow {
  cells: string[];
  nums: (number | null)[];
  kind?: 'added' | 'removed';
  /** The cells that differ from the row it was (or became). */
  changed?: boolean[];
  /** An old header shown as a removed row. */
  header?: boolean;
}

export { rowHeight };

/** A cell's padding, both sides (table.css `.csv-cell`). */
const CELL_PAD = 16;
const gutterCh = (gutter: number[]) => gutter.reduce((a, b) => a + b, 0);
const gutterPx = (gutter: number[]) => gutter.length * 8 + 8;
const round = (n: number) => Math.round(n * 10) / 10;

/**
 * A delimited file as a table: the header row sticky at the top, the row numbers sticky at the
 * left, and only the rows in view rendered (`@tanstack/react-virtual`, as the file list), so a
 * file of any length scrolls smoothly. Every row is one line high; a cell's line breaks show as ↵.
 * Text selects and copies as text; a selection across cells copies them tab-separated, a row a
 * line (from the parsed cells, so a cell cut off by its column copies whole).
 *
 * `changes`: a diff's change starts (indexes in `rows`): it opens at the first, and Previous/Next
 * change (F7) step through them.
 */
export function TableGrid({ header, headerChanged = null, rows, columns, fontPx, gutter, changes, label }: {
  header: string[];
  headerChanged?: boolean[] | null;
  rows: GridRow[];
  columns: Column[];
  fontPx: number;
  /** Characters of each number in the gutter (one or two numbers). */
  gutter: number[];
  changes?: number[];
  label: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rowH = rowHeight(fontPx);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowH,
    overscan: 20,
    // The header row sits above the rows, in the same scroll.
    scrollMargin: rowH,
    initialRect: { width: 800, height: 600 },
  });
  const laidOut = useRef(rowH);
  useLayoutEffect(() => {
    if (laidOut.current === rowH) return;
    laidOut.current = rowH;
    v.measure();
  }, [rowH, v]);
  // Each column its content's width; a pane wider than the table shares the rest out to the
  // columns by their widths (`fr`). Every row is its own grid, so the tracks never depend on the
  // cells: the row is as wide as the columns' widths add up to (`--csv-width`), or the pane.
  const style = useMemo(() => ({
    '--csv-cols': [`calc(${gutterCh(gutter)}ch + ${gutterPx(gutter)}px)`, ...columns.map((c) => `minmax(calc(${c.ch}ch + ${CELL_PAD}px), ${c.ch}fr)`)].join(' '),
    '--csv-width': `calc(${round(gutterCh(gutter) + columns.reduce((a, c) => a + c.ch, 0))}ch + ${gutterPx(gutter) + columns.length * CELL_PAD}px)`,
    '--csv-row-h': `${rowH}px`,
    '--md-font-size': `${fontPx}px`,
  }) as CSSProperties, [columns, gutter, rowH, fontPx]);
  // A diff opens at its first change, and steps through them (F7, Previous/Next change) as the
  // other diffs do (`stepTarget`): from the change the last step went to while the view is still
  // there, so the changes on the last screen are reached too, wrapping at the ends.
  const boxes = useMemo(() => (changes ? changeBoxes(rows, changes, rowH) : null), [rows, changes, rowH]);
  const marks = useMemo(() => {
    if (!changes || !boxes) return undefined;
    const list = rulerMarks(rows, changes, boxes, rowH);
    return () => list;
  }, [changes, boxes, rows, rowH]);
  const boxList = useRef(boxes);
  boxList.current = boxes;
  const lastStep = useRef<{ index: number; top: number; count: number } | null>(null);
  // The rows' view: the scroll less the sticky header, in the rows' own space.
  const rowView = (el: HTMLElement) => ({ top: el.scrollTop, height: Math.max(rowH, el.clientHeight - rowH) });
  useLayoutEffect(() => {
    const el = scroller.current;
    const first = boxList.current?.[0];
    if (el && first) el.scrollTop = openTop(first, rowView(el).height, STEP_MARGIN);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const stepping = changes !== undefined;
  useEffect(() => {
    if (!stepping) return;
    return setChangeStepper((dir: StepDir) => {
      const el = scroller.current;
      const list = boxList.current ?? [];
      if (!el) return;
      const view = rowView(el);
      const last = lastStep.current;
      const current = last && last.count === list.length && Math.abs(el.scrollTop - last.top) <= 1 ? last.index : null;
      const i = stepTarget(list, view, dir, current);
      if (i === null) return;
      el.scrollTop = revealTop(list[i]!, view.height, STEP_MARGIN);
      lastStep.current = { index: i, top: el.scrollTop, count: list.length };
    });
  }, [stepping, rowH]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCopy = (e: ClipboardEvent) => {
    const text = selectedCells(window.getSelection(), header, rows);
    if (text === null) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
  };
  const cells = (row: string[], changed: boolean[] | null | undefined, head: boolean) => columns.map((c, i) => (
    <div
      key={i}
      role={head ? 'columnheader' : 'cell'}
      data-c={i}
      className={`csv-cell${c.numeric ? ' csv-num' : ''}${changed?.[i] ? ' csv-changed' : ''}`}
    >{displayCell(row[i] ?? '')}</div>
  ));
  const gutterOf = (nums: (number | null)[]) => (
    <div className="csv-gutter" aria-hidden="true">
      {gutter.map((w, i) => <span key={i} style={{ width: `${w}ch` }}>{nums[i] ?? ''}</span>)}
    </div>
  );
  return (
    <RulerFrame pane={scroller} marks={marks}>
    <div ref={scroller} className="csv-table" role="table" aria-label={label} aria-rowcount={rows.length + 1} tabIndex={0} data-font-zoom="" style={style} onCopy={onCopy}>
      <div className="csv-row csv-head" role="row" aria-rowindex={1} data-r={-1}>
        {gutterOf([])}
        {cells(header, headerChanged, true)}
      </div>
      <div className="csv-rows" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((item) => {
          const r = rows[item.index];
          return (
            <div
              key={item.key}
              role="row"
              aria-rowindex={item.index + 2}
              data-r={item.index}
              data-kind={r.kind}
              className={`csv-row${r.header ? ' csv-old-head' : ''}`}
              style={{ transform: `translateY(${item.start - v.options.scrollMargin}px)` }}
            >
              {gutterOf(r.nums)}
              {cells(r.cells, r.changed, false)}
            </div>
          );
        })}
      </div>
    </div>
    </RulerFrame>
  );
}

/** The overview ruler's marks (`RulerFrame`), in the scroller's px: each change below the header
 * row, removed, added, or changed when its run has both. */
export function rulerMarks(rows: GridRow[], changes: number[], boxes: ChangeBox[], rowH: number): RulerMark[] {
  return changes.map((start, i) => {
    const box = boxes[i]!;
    const kinds = new Set(rows.slice(start, start + Math.max(1, Math.round((box.bottom - box.top) / rowH))).map((r) => r.kind));
    const kind: RulerKind = kinds.has('added') && kinds.has('removed') ? 'changed' : kinds.has('added') ? 'added' : 'removed';
    return { top: rowH + box.top, height: box.bottom - box.top, kind };
  });
}

/** Each change's extent in the rows' own space (px): its first row to the end of its run. */
export function changeBoxes(rows: GridRow[], changes: number[], rowH: number): ChangeBox[] {
  return changes.map((start) => {
    let end = start;
    while (end < rows.length && rows[end].kind !== undefined) end++;
    return { top: start * rowH, bottom: Math.max(end, start + 1) * rowH };
  });
}

/** A place in the grid: a row (-1, the header) and a cell (null: none, the row as a whole). */
type Place = { r: number; c: number | null };

function placeOf(node: Node | null): Place | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const row = el?.closest<HTMLElement>('[data-r]');
  if (!row) return null;
  const cell = el?.closest<HTMLElement>('[data-c]');
  return { r: Number(row.dataset.r), c: cell ? Number(cell.dataset.c) : null };
}

/** The last cell a range takes in: its end, unless that's the very start of a cell (a drag to
 * the left edge of the next cell, or of the next row), which then isn't taken. c null: through
 * the end of the row. */
function endPlace(range: Range): Place | null {
  const { endContainer: node, endOffset: offset } = range;
  if (node instanceof Element && offset > 0) {
    const before = node.childNodes[offset - 1];
    const p = placeOf(before);
    // Just after a row's gutter: nothing of that row.
    if (p && p.c === null && before instanceof Element && before.classList.contains('csv-gutter')) return { r: p.r - 1, c: null };
    return p;
  }
  const p = placeOf(node);
  if (!p || offset > 0 || p.c === null) return p;
  return p.c > 0 ? { r: p.r, c: p.c - 1 } : { r: p.r - 1, c: null };
}

/** A cell as a spreadsheet takes it: quoted (its quotes doubled) when it holds a tab, a line
 * break or a quote. */
export const copyCell = (cell: string): string => (/[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** The part of `cell` between two offsets in its shown text (`displayCell`: each line break one
 * ↵), with its real line breaks. */
export function cellSlice(cell: string, from: number, to: number): string {
  let out = '';
  let shown = 0;
  for (let i = 0; i < cell.length; shown++) {
    const len = cell[i] === '\r' && cell[i + 1] === '\n' ? 2 : 1;
    if (shown >= from && shown < to) out += cell.slice(i, i + len);
    i += len;
  }
  return out;
}

/** A selection in the grid as text. Across cells: cells tab-separated (quoted as spreadsheets
 * expect), rows a line each, from the first selected cell to the last in reading order. Within
 * one cell holding line breaks: the selected text with its real breaks. Null when the browser's
 * own copy is right (within one cell without breaks) or it's not in the grid. */
export function selectedCells(sel: Selection | null, header: string[], rows: GridRow[]): string | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const a = placeOf(range.startContainer);
  const b = endPlace(range);
  if (!a || !b || b.r < a.r) return null;
  const at = (r: number) => (r === -1 ? header : rows[r]?.cells ?? []);
  if (a.r === b.r && a.c !== null && b.c !== null && b.c <= a.c) {
    if (b.c < a.c) return null;
    const cell = at(a.r)[a.c] ?? '';
    if (!/[\r\n]/.test(cell)) return null;
    const box = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest('[data-c]');
    const from = range.startContainer.nodeType === Node.TEXT_NODE ? range.startOffset : 0;
    const to = box?.contains(range.endContainer) && range.endContainer.nodeType === Node.TEXT_NODE ? range.endOffset : Infinity;
    return cellSlice(cell, from, to);
  }
  const lines: string[] = [];
  for (let r = a.r; r <= b.r; r++) {
    const cells = at(r);
    const from = r === a.r ? a.c ?? 0 : 0;
    const to = r === b.r && b.c !== null ? b.c : cells.length - 1;
    lines.push(cells.slice(from, to + 1).map(copyCell).join('\t'));
  }
  return lines.join('\n');
}
