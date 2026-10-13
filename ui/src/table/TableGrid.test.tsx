import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { revealTop } from '../diff/changeNav';
import { changeStepper, STEP_MARGIN } from '../diff/changeStepper';
import { CsvTable, CsvTableDiff } from './CsvTable';
import { isTableCached, LARGE_TABLE_CHARS, parseTable, toTable } from './csv';
import { diffTables } from './rowDiff';
import { changeBoxes, rowHeight, selectedCells, type GridRow } from './TableGrid';

afterEach(cleanup);

const Csv = ({ text, fontPx }: { text: string; fontPx: number }) => <CsvTable text={text} table={parseTable(text, ',')} fontPx={fontPx} />;

const bodyRows = () => screen.getAllByRole('row').filter((r) => !r.classList.contains('csv-head'));
const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1},name ${i + 1}`).join('\n');

describe('CsvTable', () => {
  it('renders only the rows in view of a long file (virtualized), with the row count for assistive tech', () => {
    render(<Csv text={`id,name\n${lines(10_000)}\n`} fontPx={13} />);
    const table = screen.getByRole('table', { name: 'Table' });
    expect(table).toHaveAttribute('aria-rowcount', '10001');
    const shown = bodyRows();
    expect(shown.length).toBeGreaterThan(10);
    expect(shown.length).toBeLessThan(100);
    expect(within(shown[0]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1', 'name 1']);
  });

  it('shows the first row as the header, first in the scroll (sticky) and outside the virtualized rows', () => {
    render(<Csv text={'id,name\n1,a\n'} fontPx={13} />);
    const table = screen.getByRole('table');
    const head = table.firstElementChild as HTMLElement;
    expect(head).toHaveClass('csv-head');
    expect(within(head).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['id', 'name']);
    expect(head.parentElement).toBe(table);
  });

  it('right-aligns numeric columns in monospace (the csv-num class), and leaves text columns alone', () => {
    render(<Csv text={'qty,item\n1,apple\n2.5,pear\n'} fontPx={13} />);
    const [qty, item] = within(bodyRows()[0]).getAllByRole('cell');
    expect(qty).toHaveClass('csv-num');
    expect(item).not.toHaveClass('csv-num');
  });

  it('sizes columns from their content, and rows from the text size', () => {
    render(<Csv text={'id,description\n1,a fairly long description\n'} fontPx={16} />);
    const table = screen.getByRole('table');
    expect(table.style.getPropertyValue('--csv-cols')).toMatch(/calc\(3ch \+ 16px\) calc\(25ch \+ 16px\)$/);
    expect(table.style.getPropertyValue('--csv-row-h')).toBe(`${rowHeight(16)}px`);
    expect(table).toHaveAttribute('data-font-zoom');
  });

  it('shows ragged rows padded with empty cells, and a cell with line breaks on one line', () => {
    render(<Csv text={'a,b,c\n1\n"x\ny",2,3,4\n'} fontPx={13} />);
    const [short, long] = bodyRows();
    expect(within(short).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1', '', '', '']);
    expect(within(long).getAllByRole('cell')[0]).toHaveTextContent('x↵y');
  });

  it('numbers the rows in a gutter that selection skips', () => {
    render(<Csv text={'h\na\nb\n'} fontPx={13} />);
    const gutter = bodyRows()[1].querySelector('.csv-gutter')!;
    expect(gutter).toHaveTextContent('2');
    expect(gutter).toHaveAttribute('aria-hidden', 'true');
  });

  it("drops a large file's parse when it goes", () => {
    const text = `id,name\n${lines(80_000)}\n`;
    expect(text.length).toBeGreaterThan(LARGE_TABLE_CHARS);
    const { unmount } = render(<Csv text={text} fontPx={13} />);
    expect(isTableCached(text)).toBe(true);
    unmount();
    expect(isTableCached(text)).toBe(false);
  });

  it('is focusable, so the keys scroll it', () => {
    render(<Csv text={'h\na\n'} fontPx={13} />);
    expect(screen.getByRole('table')).toHaveAttribute('tabindex', '0');
  });

  it('copies a selection across cells tab-separated, a row a line, from the parsed cells', () => {
    render(<Csv text={'a,b,c\n1,2,3\n4,5,6\n'} fontPx={13} />);
    const [r1, r2] = bodyRows();
    const range = document.createRange();
    range.setStart(within(r1).getAllByRole('cell')[1].firstChild!, 0);
    range.setEnd(within(r2).getAllByRole('cell')[0].firstChild!, 1);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const data = new Map<string, string>();
    const event = fireEvent.copy(screen.getByRole('table'), { clipboardData: { setData: (k: string, v: string) => data.set(k, v) } });
    expect(event).toBe(false);
    expect(data.get('text/plain')).toBe('2\t3\n4');
    sel.removeAllRanges();
  });
});

describe('selectedCells', () => {
  const rows: GridRow[] = [{ cells: ['1', '2'], nums: [1] }];
  it('leaves a selection inside one cell (or none) to the browser', () => {
    render(<Csv text={'a,b\n1,2\n'} fontPx={13} />);
    const cell = within(bodyRows()[0]).getAllByRole('cell')[0];
    const range = document.createRange();
    range.setStart(cell.firstChild!, 0);
    range.setEnd(cell.firstChild!, 1);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(selectedCells(sel, ['a', 'b'], rows)).toBeNull();
    sel.removeAllRanges();
    expect(selectedCells(sel, ['a', 'b'], rows)).toBeNull();
  });

  /** Selects from `a` (node, offset) to `b`, and returns what a copy puts on the clipboard. */
  const copyOf = (a: [Node, number], b: [Node, number]) => {
    const range = document.createRange();
    range.setStart(...a);
    range.setEnd(...b);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const data = new Map<string, string>();
    fireEvent.copy(screen.getByRole('table'), { clipboardData: { setData: (k: string, v: string) => data.set(k, v) } });
    sel.removeAllRanges();
    return data.get('text/plain') ?? null;
  };
  const cellsOf = (i: number) => within(bodyRows()[i]).getAllByRole('cell');

  it("leaves out the cell (or row) a selection ends at the very start of", () => {
    render(<Csv text={'a,b,c\n1,2,3\n4,5,6\n'} fontPx={13} />);
    expect(copyOf([cellsOf(0)[0].firstChild!, 0], [cellsOf(0)[2].firstChild!, 0])).toBe('1\t2');
    expect(copyOf([cellsOf(0)[1].firstChild!, 0], [cellsOf(1)[0].firstChild!, 0])).toBe('2\t3');
    // Ending at the start of a cell element, or just after the next row's gutter.
    expect(copyOf([cellsOf(0)[0].firstChild!, 0], [cellsOf(0)[2], 0])).toBe('1\t2');
    expect(copyOf([cellsOf(0)[0].firstChild!, 0], [bodyRows()[1], 1])).toBe('1\t2\t3');
  });

  it('quotes copied cells holding a tab, a line break or a quote, as spreadsheets expect', () => {
    render(<Csv text={'a,b,c\n"x\ty","line 1\nline 2","say ""hi"""\n'} fontPx={13} />);
    expect(copyOf([cellsOf(0)[0].firstChild!, 0], [cellsOf(0)[2].firstChild!, 3])).toBe('"x\ty"\t"line 1\nline 2"\t"say ""hi"""');
  });

  it('copies part of one cell with its real line breaks, not the ↵ it shows', () => {
    render(<Csv text={'a,b\n"one\r\ntwo\nthree",x\n'} fontPx={13} />);
    const text = cellsOf(0)[0].firstChild!;
    expect(text.textContent).toBe('one↵two↵three');
    expect(copyOf([text, 1], [text, 9])).toBe('ne\r\ntwo\nt');
    // To the start of the next cell: the rest of this one.
    expect(copyOf([text, 4], [cellsOf(0)[1].firstChild!, 0])).toBe('two\nthree');
    // A cell without breaks: the browser's own copy.
    expect(copyOf([cellsOf(0)[1].firstChild!, 0], [cellsOf(0)[1].firstChild!, 1])).toBeNull();
  });

  it('copies from the header too', () => {
    render(<Csv text={'a,b\n1,2\n'} fontPx={13} />);
    const range = document.createRange();
    range.setStart(screen.getAllByRole('columnheader')[0].firstChild!, 0);
    range.setEnd(within(bodyRows()[0]).getAllByRole('cell')[1].firstChild!, 1);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(selectedCells(sel, ['a', 'b'], rows)).toBe('a\tb\n1\t2');
    sel.removeAllRanges();
  });
});

describe('CsvTableDiff', () => {
  const diffOf = (old: string[][], neu: string[][]) => diffTables(toTable(old), toTable(neu))!;

  it('marks added and removed rows, and the cells a changed row changed', () => {
    render(<CsvTableDiff diff={diffOf([['k', 'v'], ['a', '1'], ['b', '2']], [['k', 'v'], ['a', '9'], ['b', '2'], ['c', '3']])} fontPx={13} />);
    const rows = bodyRows();
    expect(rows.map((r) => r.dataset.kind ?? 'same')).toEqual(['removed', 'added', 'same', 'added']);
    expect(within(rows[0]).getAllByRole('cell').map((c) => c.classList.contains('csv-changed'))).toEqual([false, true]);
    expect(within(rows[1]).getAllByRole('cell').map((c) => c.classList.contains('csv-changed'))).toEqual([false, true]);
    // Old and new row numbers in the gutter.
    expect([...rows[2].querySelectorAll('.csv-gutter > span')].map((s) => s.textContent)).toEqual(['2', '2']);
    expect([...rows[3].querySelectorAll('.csv-gutter > span')].map((s) => s.textContent)).toEqual(['', '3']);
  });

  it("marks a changed header's cells, and shows the old header as a removed row", () => {
    render(<CsvTableDiff diff={diffOf([['id', 'name'], ['1', 'a']], [['id', 'label'], ['1', 'a']])} fontPx={13} />);
    expect(screen.getAllByRole('columnheader').map((c) => c.classList.contains('csv-changed'))).toEqual([false, true]);
    expect(bodyRows()[0]).toHaveClass('csv-old-head');
  });

  const h = rowHeight(13);
  /** The scroll that centres rows `from`..`to` (exclusive) in the rows' view (the pane less the header). */
  const centred = (from: number, to: number) => revealTop({ top: from * h, bottom: to * h }, 600 - h, STEP_MARGIN);

  it('opens at its first change, and Previous/Next change step through the changes, wrapping at the ends', () => {
    const old = [['k', 'v'], ...Array.from({ length: 200 }, (_, i) => [`r${i}`, '0'])];
    const neu = old.map((r, i) => (i === 50 || i === 150 ? [r[0], '1'] : r));
    const diff = diffOf(old, neu);
    expect(diff.changes).toEqual([49, 150]);
    render(<CsvTableDiff diff={diff} fontPx={13} />);
    const table = screen.getByRole('table', { name: 'Table diff' });
    expect(table.scrollTop).toBe(centred(49, 51));
    act(() => changeStepper()!('next'));
    expect(table.scrollTop).toBe(centred(150, 152));
    act(() => changeStepper()!('next'));
    expect(table.scrollTop).toBe(centred(49, 51));
    act(() => changeStepper()!('previous'));
    expect(table.scrollTop).toBe(centred(150, 152));
  });

  it("reaches a change on the last screen, where the scroll can't move to centre it, and wraps from it", () => {
    const old = [['k', 'v'], ...Array.from({ length: 100 }, (_, i) => [`r${i}`, '0'])];
    const neu = old.map((r, i) => (i === 80 || i === 99 ? [r[0], '1'] : r));
    const diff = diffOf(old, neu);
    render(<CsvTableDiff diff={diff} fontPx={13} />);
    const table = screen.getByRole('table', { name: 'Table diff' });
    const [first, last] = changeBoxes(diff.rows.map((r) => ({ cells: r.cells, nums: [], kind: r.kind === 'same' ? undefined : r.kind })), diff.changes, h);
    // A browser clamps the scroll at the end: the last change sits below the centre of the last screen.
    const max = (diff.rows.length + 1) * h - 600;
    expect(last.top).toBeGreaterThan(max + (600 - h) / 2);
    let top = 0;
    Object.defineProperty(table, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(max, v)); } });
    table.scrollTop = 0;
    const stops: number[] = [];
    for (let k = 0; k < 3; k++) { act(() => changeStepper()!('next')); stops.push(top); }
    const firstTop = revealTop(first, 600 - h, STEP_MARGIN);
    expect(firstTop).toBeLessThan(max);
    expect(stops).toEqual([firstTop, max, firstTop]);
  });

  it('gives the stepper back when it goes', () => {
    const { unmount } = render(<CsvTableDiff diff={diffOf([['v'], ['a']], [['v'], ['b']])} fontPx={13} />);
    expect(changeStepper()).not.toBeNull();
    unmount();
    expect(changeStepper()).toBeNull();
  });
});

// jsdom doesn't load CSS (see diff.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'table.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('table.css', () => {
  it('keeps the header at the top and the row numbers at the left as the table scrolls', () => {
    expect(rule('.csv-head')).toMatch(/position:\s*sticky;\s*top:\s*0/);
    expect(rule('.csv-gutter')).toMatch(/position:\s*sticky;\s*left:\s*0/);
    expect(rule('.csv-gutter')).toMatch(/user-select:\s*none/);
  });

  it('right-aligns numbers in monospace, and colours with theme tokens', () => {
    expect(rule('.csv-cell.csv-num')).toMatch(/font-family:\s*var\(--font-mono\);\s*text-align:\s*right/);
    expect(rule('.csv-row[data-kind="added"]')).toMatch(/var\(--diff-inserted-line\)/);
    expect(rule('.csv-row[data-kind="removed"]')).toMatch(/var\(--diff-removed-line\)/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
