import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphView } from './GraphView';
import { formatDate } from '../format/date';
import { METRICS } from './metrics';
import { DEFAULT_DENSITY, DENSITIES, DENSITY_METRICS, useDensity } from '../theme/density';
import { COLUMN_MIN, columnPrefsPersistence, SHA_MAX, SHA_W, useColumnPrefs } from './columns';
import { createCommitMessageCache } from '../api/commitMessages';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { copyText } from '../api/transport';
import { useToast } from '../ui/toast';

vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));

HTMLCanvasElement.prototype.getContext = (() => null) as never;
// jsdom does no layout: give the scroll viewport a width so the smart fit has room to allocate.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });

const graph: GraphPayload = {
  rows: [
    { id: 'a'.repeat(40), kind: 'commit', lane: 0, color: 0, segments: [], summary: 'Second', bodyFirstLine: 'details', authorName: 'Ada Lovelace', authorEmail: '', authorTime: 1_767_225_600, committerTime: 1_767_227_520, parents: ['b'.repeat(40)], mrRefs: [], wip: null },
    { id: 'b'.repeat(40), kind: 'commit', lane: 0, color: 0, segments: [], summary: 'First', bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: '', authorTime: 1_767_225_000, committerTime: 1_767_225_000, parents: [], mrRefs: [], wip: null },
  ],
  labels: [{ row: 0, name: 'main', local: 'refs/heads/main', remotes: [], tag: false, isHead: true, worktree: null }],
  maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: 'a'.repeat(40), detached: false, unborn: false }, truncated: false,
};

beforeEach(() => useDensity.setState({ density: DEFAULT_DENSITY }));

describe('GraphView', () => {
  it('renders rows with summary, dimmed body, author and short sha', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('details')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getAllByTestId('sha')[0]).toHaveTextContent('aaaaaa');
  });

  it('shows the committer timestamp, not the author timestamp, in the date column', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const row0 = screen.getAllByRole('row')[0];
    const dateCell = row0.querySelector('.col-date')!;
    // Row 0 was amended 32 minutes after it was authored: the column shows the committer time.
    expect(dateCell).toHaveTextContent(formatDate(1_767_227_520));
    expect(dateCell).not.toHaveTextContent(formatDate(1_767_225_600));
  });

  it('uses the single-sourced row height of the default density (standard, 28 px) for the DOM rows', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    expect(METRICS.rowH).toBe(28);
    for (const r of screen.getAllByRole('row')) expect(r).toHaveStyle({ height: '28px' });
  });

  it('follows the density live: rows, their positions and the CSS variables on :root, where the details panel sees them too (H1)', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    for (const d of DENSITIES) {
      act(() => useDensity.setState({ density: d }));
      const { rowH, cellPadX, chipH } = DENSITY_METRICS[d];
      const rows = screen.getAllByRole('row');
      for (const r of rows) expect(r, d).toHaveStyle({ height: `${rowH}px` });
      expect(rows[1], d).toHaveStyle({ top: `${rowH}px` });
      const root = document.documentElement.style;
      expect(root.getPropertyValue('--graph-cell-pad-x'), d).toBe(`${cellPadX}px`);
      expect(root.getPropertyValue('--graph-chip-h'), d).toBe(`${chipH}px`);
      expect(root.getPropertyValue('--file-row-h'), d).toBe(`${DENSITY_METRICS[d].fileRowH}px`);
    }
  });

  it('puts the dimmed body in its own element with no leading text space (the gap is CSS margin)', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const body = screen.getByText('details');
    expect(body).toHaveClass('msg-body');
    expect(body.textContent).toBe('details');
    const summary = screen.getByText('Second');
    expect(summary).toHaveClass('msg-summary');
    expect(summary.nextSibling).toBe(body);
  });

  it('controlled selection reports Ctrl+clicks and draws compare markers', () => {
    const onSelect = vi.fn();
    render(<GraphView graph={graph} repoId="/r" selected={1} onSelect={onSelect} compare={{ a: 0, b: 1 }} />);
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.mouseDown(rows[0], { ctrlKey: true });
    expect(onSelect).toHaveBeenCalledWith(0, { ctrl: true });
    expect(within(rows[0]).getByTestId('compare-a')).toHaveTextContent('A');
    expect(within(rows[1]).getByTestId('compare-b')).toHaveTextContent('B');
  });

  it('in the Branch/Tag column only the chips select the row: empty space and the connector do nothing (F6)', () => {
    const onSelect = vi.fn();
    render(<GraphView graph={graph} repoId="/r" selected={-1} onSelect={onSelect} />);
    const rows = screen.getAllByRole('row');
    const labelsCell = (i: number) => rows[i].querySelector<HTMLElement>('[data-col="labels"]')!;
    fireEvent.mouseDown(labelsCell(1)); // no chips at all on row 1
    fireEvent.mouseDown(labelsCell(0)); // beside row 0's chip
    fireEvent.mouseDown(labelsCell(0).querySelector('.ref-connector')!);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.mouseDown(within(labelsCell(0)).getByText('main'));
    expect(onSelect).toHaveBeenLastCalledWith(0, { ctrl: false });
    // The other columns still select their row.
    for (const col of ['graph', 'message', 'author', 'date']) {
      onSelect.mockClear();
      fireEvent.mouseDown(rows[1].querySelector(`[data-col="${col}"]`)!);
      expect(onSelect, col).toHaveBeenCalledWith(1, { ctrl: false });
    }
  });

  it('a hovered or selected commit below its branch tip shows a dimmed chip naming the branch (F7), which selects its row like the others (J6)', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<GraphView graph={graph} repoId="/r" selected={-1} onSelect={onSelect} />);
    const rows = () => screen.getAllByRole('row');
    const dim = (i: number) => rows()[i].querySelector<HTMLElement>('[data-col="labels"] .ref-label-dim');
    expect(dim(1)).toBeNull();
    fireEvent.mouseEnter(rows()[1]);
    expect(dim(1)).toHaveTextContent('main');
    // A press on it selects the row, as on any chip (J6); it has no tooltip.
    fireEvent.mouseDown(dim(1)!);
    expect(onSelect).toHaveBeenCalledWith(1, { ctrl: false });
    fireEvent.mouseEnter(dim(1)!);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseLeave(rows()[1]);
    expect(dim(1)).toBeNull();
    // The tip itself (row 0, which has the "main" chip) never gets one.
    fireEvent.mouseEnter(rows()[0]);
    expect(dim(0)).toBeNull();
    fireEvent.mouseLeave(rows()[0]);
    // Selected (not hovered): shown too.
    rerender(<GraphView graph={graph} repoId="/r" selected={1} onSelect={onSelect} />);
    expect(dim(1)).toHaveTextContent('main');
  });

  it('keys the hovered membership chip by commit, so a refresh that shifts the rows keeps it on the same commit (F7)', () => {
    const { rerender } = render(<GraphView graph={graph} repoId="/r" />);
    fireEvent.mouseEnter(screen.getAllByRole('row')[1]);
    expect(screen.getAllByRole('row')[1].querySelector('.ref-label-dim')).toHaveTextContent('main');
    // A new commit on top (rows shift down by one; the pointer hasn't moved, no new mouseenter).
    const c = { ...graph.rows[0], id: 'c'.repeat(40), summary: 'Third', parents: [graph.rows[0].id] };
    const next: GraphPayload = { ...graph, rows: [c, ...graph.rows], labels: [{ ...graph.labels[0], row: 0 }] };
    rerender(<GraphView graph={next} repoId="/r" />);
    const rows = screen.getAllByRole('row');
    expect(rows[1].querySelector('.ref-label-dim')).toBeNull();
    expect(rows[2]).toHaveTextContent('First');
    expect(rows[2].querySelector('.ref-label-dim')).toHaveTextContent('main');
  });

  it('a row with chips that aren\'t its branch\'s tip (a tag) shows the dimmed chip after them (F7)', () => {
    const tagged: GraphPayload = { ...graph, labels: [...graph.labels, { row: 1, name: 'v1', local: null, remotes: [], tag: true, isHead: false, worktree: null }] };
    render(<GraphView graph={tagged} repoId="/r" />);
    const row = screen.getAllByRole('row')[1];
    fireEvent.mouseEnter(row);
    const labels = row.querySelector('.ref-labels')!;
    expect(labels.querySelector(':scope > .ref-label')).toHaveTextContent('v1');
    expect(labels.querySelector('.ref-dim-slot .ref-label-dim')).toHaveTextContent('main');
    // The tip row (main's own chip) still gets none.
    fireEvent.mouseLeave(row);
    fireEvent.mouseEnter(screen.getAllByRole('row')[0]);
    expect(document.querySelector('.ref-label-dim')).toBeNull();
  });

  it('passes keys it does not handle to onUnhandledKey', () => {
    const onKey = vi.fn(() => true);
    render(<GraphView graph={graph} repoId="/r" selected={0} onSelect={() => {}} onUnhandledKey={onKey} />);
    fireEvent.keyDown(screen.getByRole('grid', { name: 'Commit graph' }), { key: 'Enter' });
    expect(onKey).toHaveBeenCalledWith('Enter');
  });

  it('forwards to onUnhandledKey only keys aimed at the grid itself, with no Ctrl/Alt/Meta', () => {
    const onKey = vi.fn(() => true);
    render(<GraphView graph={graph} repoId="/r" selected={0} onSelect={() => {}} onUnhandledKey={onKey} />);
    // Enter on a Tab-focused SHA button: not forwarded and not prevented, so the browser's
    // Enter-activates-button click (the copy) goes ahead.
    expect(fireEvent.keyDown(screen.getAllByTestId('sha')[0], { key: 'Enter' })).toBe(true);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    for (const mod of ['ctrlKey', 'altKey', 'metaKey']) expect(fireEvent.keyDown(grid, { key: 'Enter', [mod]: true })).toBe(true);
    expect(onKey).not.toHaveBeenCalled();
    fireEvent.keyDown(grid, { key: 'Enter', shiftKey: true });
    expect(onKey).toHaveBeenCalledWith('Enter');
  });

  it('labels the compare badges for assistive technology', () => {
    render(<GraphView graph={graph} repoId="/r" selected={1} onSelect={() => {}} compare={{ a: 0, b: 1 }} />);
    expect(screen.getByRole('img', { name: 'Compare A' })).toHaveTextContent('A');
    expect(screen.getByRole('img', { name: 'Compare B' })).toHaveTextContent('B');
  });

  it('arrow keys move the selection', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.getAllByRole('row')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('a row SHA click copies the full id, and a failed copy shows a toast instead of an unhandled rejection', async () => {
    useToast.setState({ message: null });
    render(<GraphView graph={graph} repoId="/repo" />);
    await act(async () => fireEvent.click(screen.getAllByTestId('sha')[0]));
    expect(copyText).toHaveBeenLastCalledWith('a'.repeat(40));
    expect(useToast.getState().message).toBe('Copied');
    vi.mocked(copyText).mockRejectedValueOnce(new Error('denied'));
    await act(async () => fireEvent.click(screen.getAllByTestId('sha')[1]));
    expect(useToast.getState().message).toBe('Copy failed');
  });
});

describe('GraphView full-message tooltip (lazy-loaded)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const msgCell = (i: number) => screen.getAllByRole('row')[i].querySelector<HTMLElement>('[data-col="message"]')!;
  const full: CommitMessage = { id: 'a'.repeat(40), summary: 'Second', body: 'details\n\nMore about it,\nover two lines.' };
  const loader = () => vi.fn(async (id: string): Promise<CommitMessage> => (id === full.id ? full : { id, summary: 'First', body: '' }));

  it('loads and shows the whole message only after the pointer rests ~500 ms on the message cell', async () => {
    const load = loader();
    render(<GraphView graph={graph} repoId="/repo" messages={createCommitMessageCache(load)} />);
    fireEvent.mouseEnter(msgCell(0));
    act(() => vi.advanceTimersByTime(400));
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).toBeNull();
    await act(async () => vi.advanceTimersByTime(100));
    expect(load).toHaveBeenCalledWith(full.id);
    const tip = screen.getByRole('tooltip');
    // Summary, then the full body with its line breaks kept.
    expect(tip.querySelector('.msg-tooltip-summary')!.textContent).toBe('Second');
    expect(tip.querySelector('.msg-tooltip-body')!.textContent).toBe(full.body);
    fireEvent.mouseLeave(msgCell(0));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('caches per commit: a second rest shows it without another load', async () => {
    const load = loader();
    render(<GraphView graph={graph} repoId="/repo" messages={createCommitMessageCache(load)} />);
    fireEvent.mouseEnter(msgCell(0));
    await act(async () => vi.advanceTimersByTime(500));
    fireEvent.mouseLeave(msgCell(0));
    fireEvent.mouseEnter(msgCell(0));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('tooltip').querySelector('.msg-tooltip-body')!.textContent).toBe(full.body);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('moving off before the delay cancels it (nothing is loaded)', () => {
    const load = loader();
    render(<GraphView graph={graph} repoId="/repo" messages={createCommitMessageCache(load)} />);
    fireEvent.mouseEnter(msgCell(0));
    act(() => vi.advanceTimersByTime(300));
    fireEvent.mouseLeave(msgCell(0));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('a commit without a body shows just its summary', async () => {
    render(<GraphView graph={graph} repoId="/repo" messages={createCommitMessageCache(loader())} />);
    fireEvent.mouseEnter(msgCell(1));
    await act(async () => vi.advanceTimersByTime(500));
    expect(screen.getByRole('tooltip').textContent).toBe('First');
  });

  it('scrolling the grid hides it, and cancels a pending one', async () => {
    const load = loader();
    render(<GraphView graph={graph} repoId="/repo" messages={createCommitMessageCache(load)} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseEnter(msgCell(0));
    await act(async () => vi.advanceTimersByTime(500));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.scroll(grid);
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseLeave(msgCell(1));
    fireEvent.mouseEnter(msgCell(1));
    act(() => vi.advanceTimersByTime(300));
    fireEvent.scroll(grid);
    await act(async () => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('sits right of the cursor, ignores the pointer, and hides as soon as the pointer moves to the next row', async () => {
    render(<GraphView graph={graph} repoId="/repo" messages={createCommitMessageCache(loader())} />);
    fireEvent.mouseEnter(msgCell(0), { clientX: 300, clientY: 12 });
    await act(async () => vi.advanceTimersByTime(500));
    const tip = screen.getByRole('tooltip');
    expect(tip.style.left).toBe('312px');
    expect(tip.style.top).toBe('12px');
    // Not interactive (so `pointer-events: none` from tooltip.css): it can never catch the
    // pointer, so the pointer always reaches the row beneath it.
    expect(tip).not.toHaveClass('interactive');
    // It follows the pointer along the message.
    fireEvent.mouseMove(msgCell(0), { clientX: 420, clientY: 14 });
    expect(tip.style.left).toBe('432px');
    // Straight down onto the next row's message: the first one's tooltip is gone at once.
    fireEvent.mouseLeave(msgCell(0), { relatedTarget: msgCell(1) });
    fireEvent.mouseEnter(msgCell(1), { clientX: 300, clientY: 37 });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('WIP rows get no message tooltip', () => {
    const load = loader();
    const wip: GraphPayload = { ...graph, rows: [{ ...graph.rows[0], id: 'wip:/repo', kind: 'wip', summary: '// WIP', bodyFirstLine: '', wip: { worktreePath: '/repo', worktreeName: null, modified: 1, added: 0, deleted: 0, conflicted: 0 } }, graph.rows[1]] };
    render(<GraphView graph={wip} repoId="/repo" messages={createCommitMessageCache(load)} />);
    fireEvent.mouseEnter(msgCell(0));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('GraphView row positioning', () => {
  it('places rows with `top`, not `transform`, so a row is not its own stacking context', () => {
    // A transform would trap the hover-expanded label chip (z-index, graph.css) under the canvas.
    render(<GraphView graph={graph} repoId="/repo" />);
    const rows = screen.getAllByRole('row');
    expect(rows[1].style.transform).toBe('');
    expect(rows[1]).toHaveStyle({ top: `${METRICS.rowH}px` });
  });
});

describe('GraphView columns', () => {
  beforeEach(() => useColumnPrefs.getState().reset());

  const header = (col: string) => document.querySelector<HTMLElement>(`.graph-header [data-col="${col}"]`)!;
  const cell = (col: string) => screen.getAllByRole('row')[0].querySelector<HTMLElement>(`[data-col="${col}"]`)!;
  const separator = (name: RegExp) => screen.getByRole('separator', { name });

  it('renders a keyboard-focusable vertical separator on the right edge of every column but SHA (the last)', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const seps = screen.getAllByRole('separator');
    expect(seps.map((s) => s.getAttribute('aria-label'))).toEqual(['Resize Branch / Tag column', 'Resize Graph column', 'Resize Commit message column', 'Resize Author column', 'Resize Date column']);
    expect(header('sha').querySelector('[role="separator"]')).toBeNull();
    // Each sits in (and on the right edge of) the header cell of the column it resizes (F3).
    for (const [name, col] of [[/Branch/, 'labels'], [/Graph/, 'graph'], [/Commit message/, 'message'], [/Author/, 'author'], [/Date/, 'date']] as const) {
      expect(separator(name).parentElement).toBe(header(col));
      expect(separator(name)).toHaveClass('end');
    }
    for (const s of seps) {
      expect(s).toHaveAttribute('aria-orientation', 'vertical');
      expect(s).toHaveAttribute('tabindex', '0');
    }
    expect(separator(/Branch/)).toHaveAttribute('aria-valuenow', '200');
    expect(separator(/Branch/)).toHaveAttribute('aria-valuemin', String(COLUMN_MIN.labels));
  });

  it('Left/Right move a boundary by 8px; header, rows and canvas follow Branch/Tag and Graph live', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const canvas = screen.getByTestId('graph-canvas');
    const graphW = parseFloat(canvas.style.width);
    fireEvent.keyDown(separator(/Branch/), { key: 'ArrowRight' });
    fireEvent.keyDown(separator(/Branch/), { key: 'ArrowRight' });
    expect(separator(/Branch/)).toHaveAttribute('aria-valuenow', '216');
    expect(header('labels')).toHaveStyle({ width: '216px' });
    expect(cell('labels')).toHaveStyle({ width: '216px' });
    expect(canvas).toHaveStyle({ left: '216px' });

    // Graph starts at its lanes' width, its max (F2): ArrowRight stops there, ArrowLeft narrows.
    fireEvent.keyDown(separator(/Graph/), { key: 'ArrowRight' });
    expect(canvas).toHaveStyle({ width: `${graphW}px` });
    fireEvent.keyDown(separator(/Graph/), { key: 'ArrowLeft' });
    expect(canvas).toHaveStyle({ width: `${graphW - 8}px` });
    expect(header('graph')).toHaveStyle({ width: `${graphW - 8}px` });
    expect(cell('graph')).toHaveStyle({ width: `${graphW - 8}px` });

    // Commit message's right edge trades with Author; Author's right edge trades with Date (F3).
    const message = parseFloat(cell('message').style.width);
    fireEvent.keyDown(separator(/Commit message/), { key: 'ArrowRight' });
    expect(cell('message')).toHaveStyle({ width: `${message + 8}px` });
    expect(cell('author')).toHaveStyle({ width: '152px' });
    fireEvent.keyDown(separator(/Author/), { key: 'ArrowRight' });
    expect(cell('author')).toHaveStyle({ width: '160px' });
    expect(cell('date')).toHaveStyle({ width: '162px' });
    expect(header('date')).toHaveStyle({ width: '162px' });
    expect(cell('message')).toHaveStyle({ width: `${message + 8}px` });
  });

  it('dragging each column\'s right-edge handle resizes that column, the handle staying under the pointer (F3)', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const right = (col: string) => leftOf(col) + cellW(col);
    for (const [name, col, dx] of [[/Branch/, 'labels', 12], [/Commit message/, 'message', 12], [/Author/, 'author', 12], [/Date/, 'date', -12]] as const) {
      const w0 = cellW(col), x0 = right(col);
      // Date's handle is dragged left (SHA takes the width): rightward, SHA can't give any
      // (its default is its minimum, H15).
      if (dx < 0) {
        dragBy(separator(name), dx, (d) => {
          expect(right(col), `${col} d=${d}`).toBe(x0 + d);
          expect(cellW(col)).toBe(w0 + d);
          expect(cellW('sha')).toBe(SHA_W - d);
        });
        continue;
      }
      dragBy(separator(name), dx, (d) => {
        expect(right(col), `${col} d=${d}`).toBe(x0 + d);
        expect(cellW(col)).toBe(w0 + d);
      });
      dragBy(separator(name), -20, (d) => expect(cellW(col), `${col} d=${d}`).toBe(w0 + 12 + d));
    }
    // Graph is at its lanes' width by default: narrowing tracks the pointer.
    const g0 = cellW('graph'), gx = right('graph');
    dragBy(separator(/Graph/), -10, (d) => {
      expect(right('graph'), `graph d=${d}`).toBe(gx + d);
      expect(cellW('graph')).toBe(g0 + d);
    });
  });

  it('never goes below a column minimum', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    for (let i = 0; i < 30; i++) fireEvent.keyDown(separator(/Branch/), { key: 'ArrowLeft' });
    expect(separator(/Branch/)).toHaveAttribute('aria-valuenow', String(COLUMN_MIN.labels));
    expect(screen.getByTestId('graph-canvas')).toHaveStyle({ left: `${COLUMN_MIN.labels}px` });
  });

  it('drags a boundary with the pointer', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const sep = separator(/Branch/);
    fireEvent.pointerDown(sep, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep, { clientX: 160, pointerId: 1 });
    expect(cell('labels')).toHaveStyle({ width: '260px' });
    fireEvent.pointerUp(sep, { clientX: 160, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 });
    expect(cell('labels')).toHaveStyle({ width: '260px' });
  });

  it('Message takes the remaining width and cells match their header', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const widths = ['labels', 'graph', 'message', 'author', 'date', 'sha'].map((c) => parseFloat(cell(c).style.width));
    expect(widths.reduce((a, b) => a + b, 0)).toBe(1200);
    for (const c of ['labels', 'graph', 'message', 'author', 'date', 'sha']) expect(header(c).style.width).toBe(cell(c).style.width);
  });

  it('keeps the header scrolled in step with the table horizontally', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    grid.scrollLeft = 120;
    fireEvent.scroll(grid);
    expect(document.querySelector('.graph-header-inner')).toHaveStyle({ transform: 'translateX(-120px)' });
    expect(screen.getByTestId('graph-canvas')).toHaveStyle({ left: '80px' });
  });
});

describe('GraphView columns: aria, persistence, canvas clip', () => {
  beforeEach(() => useColumnPrefs.getState().reset());
  afterEach(() => vi.restoreAllMocks());

  it('gives each separator an aria-valuemin/max: Branch/Tag up to the width left by the others\' minimums; Message and Author up to what their right neighbour can give', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const minSum = COLUMN_MIN.labels + COLUMN_MIN.graph + COLUMN_MIN.message + COLUMN_MIN.author + COLUMN_MIN.date + COLUMN_MIN.sha;
    const sep = (name: RegExp) => screen.getByRole('separator', { name });
    expect(sep(/Branch/)).toHaveAttribute('aria-valuemax', String(1200 - (minSum - COLUMN_MIN.labels)));
    const message = cellW('message');
    expect(sep(/Commit message/)).toHaveAttribute('aria-valuenow', String(message));
    expect(sep(/Commit message/)).toHaveAttribute('aria-valuemin', String(COLUMN_MIN.message));
    expect(sep(/Commit message/)).toHaveAttribute('aria-valuemax', String(message + 160 - COLUMN_MIN.author));
    expect(sep(/Author/)).toHaveAttribute('aria-valuemin', String(COLUMN_MIN.author));
    expect(sep(/Author/)).toHaveAttribute('aria-valuemax', String(160 + 170 - COLUMN_MIN.date));
    // Date trades with SHA: down to what SHA_MAX allows, up to SHA's minimum.
    expect(sep(/Date/)).toHaveAttribute('aria-valuemin', String(Math.max(COLUMN_MIN.date, 170 - (SHA_MAX - SHA_W))));
    expect(sep(/Date/)).toHaveAttribute('aria-valuemax', String(170 + SHA_W - COLUMN_MIN.sha));
  });

  it('the SHA cell holds the whole hash (the column shows as many whole characters as fit)', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    expect(screen.getAllByTestId('sha')[0].textContent).toBe('a'.repeat(40));
  });

  it('loads widths for its repo and saves once per gesture, not per pointer move', () => {
    const load = vi.spyOn(columnPrefsPersistence, 'load');
    const save = vi.spyOn(columnPrefsPersistence, 'save');
    render(<GraphView graph={graph} repoId="/repo/x" />);
    expect(load).toHaveBeenCalledWith('/repo/x');
    const sep = screen.getByRole('separator', { name: /Branch/ });
    fireEvent.pointerDown(sep, { clientX: 100, pointerId: 1, button: 0 });
    for (let x = 101; x <= 110; x++) fireEvent.pointerMove(sep, { clientX: x, pointerId: 1 });
    expect(save).not.toHaveBeenCalled();
    fireEvent.pointerUp(sep, { clientX: 110, pointerId: 1 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBe('/repo/x');
    expect(save.mock.calls[0][1].labels).toBe(210);
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('clips the canvas to the scroll viewport, so it never paints over the vertical scrollbar', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const canvas = screen.getByTestId('graph-canvas');
    const clip = canvas.parentElement!;
    expect(clip).toHaveClass('graph-canvas-clip');
    // clientWidth/clientHeight exclude the scrollbars (1200 x 600 in this jsdom setup).
    expect(clip).toHaveStyle({ width: '1200px', height: '600px' });
  });
});

/** Runs a describe block's tests with the scroll viewport `w` px wide. */
function withClientWidth(w: number) {
  beforeEach(() => {
    useColumnPrefs.getState().reset();
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: w });
  });
  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
  });
}
const cellW = (col: string) => parseFloat(screen.getAllByRole('row')[0].querySelector<HTMLElement>(`[data-col="${col}"]`)!.style.width);
/** Left x of a column, from the allocated widths (jsdom does no layout). */
const leftOf = (col: string) => {
  const order = ['labels', 'graph', 'message', 'author', 'date', 'sha'];
  return order.slice(0, order.indexOf(col)).reduce((x, c) => x + cellW(c), 0);
};
/** Drags `sep` from x=500 by `to` px in 1 px steps, calling `each(d)` after every step. */
function dragBy(sep: HTMLElement, to: number, each: (d: number) => void) {
  fireEvent.pointerDown(sep, { clientX: 500, pointerId: 1, button: 0 });
  const dir = Math.sign(to);
  for (let d = dir; Math.abs(d) <= Math.abs(to); d += dir) {
    fireEvent.pointerMove(sep, { clientX: 500 + d, pointerId: 1 });
    each(d);
  }
  fireEvent.pointerUp(sep, { clientX: 500 + to, pointerId: 1 });
}

describe('GraphView columns while Author/Date are squeezed (clientWidth 778)', () => {
  // Default prefs and a 64 px graph at 778 px: Message at its 160 minimum, Author 140 (pref
  // 160), Date 154 (pref 170). The boundary under the pointer is the one that moves.
  withClientWidth(778);

  it('precondition: squeezed', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    expect([cellW('message'), cellW('author'), cellW('date')]).toEqual([COLUMN_MIN.message, 140, 154]);
  });

  it('Commit message: ArrowLeft/drag-left hit its own minimum (a wall); ArrowRight/drag-right track exactly, out of Author', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const sep = screen.getByRole('separator', { name: /Commit message/ });
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect([cellW('message'), cellW('author'), cellW('date')]).toEqual([160, 140, 154]);
    dragBy(sep, -20, () => expect(cellW('message')).toBe(160));
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect([cellW('message'), cellW('author'), cellW('date')]).toEqual([168, 132, 154]);
    const x0 = leftOf('author');
    dragBy(sep, 30, (d) => expect(leftOf('author'), `d=${d}`).toBe(x0 + d));
  });

  it('Author: its right edge trades 1:1 with Date (handle under the pointer) until either is at its minimum', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const sep = screen.getByRole('separator', { name: /Author/ });
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect([cellW('author'), cellW('date'), cellW('message')]).toEqual([148, 146, 160]);
    const x0 = leftOf('date');
    const room = cellW('author') - COLUMN_MIN.author; // 88
    dragBy(sep, -100, (d) => expect(leftOf('date'), `d=${d}`).toBe(x0 - Math.min(-d, room)));
    expect(cellW('author')).toBe(COLUMN_MIN.author);
    expect(cellW('message')).toBe(160);
  });
});

/** 40 lanes: every lane plus padding is 40 * 16 + 16 = 656 px, the Graph column's max (F2). */
const wideGraph: GraphPayload = { ...graph, maxLanes: 40 };

describe('GraphView: Branch/Tag and Graph wider than columnMax after the window narrowed (clientWidth 1000)', () => {
  withClientWidth(1000);

  for (const [col, name, wide] of [['labels', /Branch/, 700], ['graph', /Graph/, 600]] as const) {
    it(`${col} at ${wide}: ArrowRight and a rightward drag never shrink it; leftward moves track`, () => {
      useColumnPrefs.getState().loadFor('/repo'); // the repo GraphView mounts with, so its load keeps these prefs
      useColumnPrefs.getState().setWidth(col, wide);
      render(<GraphView graph={wideGraph} repoId="/repo" />);
      const sep = screen.getByRole('separator', { name });
      expect(Number(sep.getAttribute('aria-valuemax'))).toBeGreaterThanOrEqual(Number(sep.getAttribute('aria-valuenow')));
      fireEvent.keyDown(sep, { key: 'ArrowRight' });
      expect(cellW(col)).toBe(wide);
      dragBy(sep, 10, (d) => expect(cellW(col), `d=${d}`).toBe(wide));
      dragBy(sep, -10, (d) => expect(cellW(col), `d=${d}`).toBe(wide + d));
      fireEvent.keyDown(sep, { key: 'ArrowLeft' });
      expect(cellW(col)).toBe(wide - 18);
      expect(Number(sep.getAttribute('aria-valuemax'))).toBeGreaterThanOrEqual(Number(sep.getAttribute('aria-valuenow')));
    });
  }
});

describe('GraphView: the Graph column\'s max width and the overflow strip (F2)', () => {
  beforeEach(() => useColumnPrefs.getState().reset());
  const canvas = () => screen.getByTestId('graph-canvas');
  const need = 40 * METRICS.laneW + 2 * METRICS.padX; // 902 at the default (standard) density

  it('defaults to exactly its lanes\' width, reports it as the handle\'s max, and isn\'t clipped', () => {
    render(<GraphView graph={wideGraph} repoId="/repo" />);
    expect(cellW('graph')).toBe(need);
    expect(screen.getByRole('separator', { name: /Graph/ })).toHaveAttribute('aria-valuemax', String(need));
    expect(canvas()).toHaveAttribute('data-clipped', 'false');
    const sep = screen.getByRole('separator', { name: /Graph/ });
    dragBy(sep, 40, (d) => expect(cellW('graph'), `d=${d}`).toBe(need));
  });

  it('narrowed below its lanes\' width, the graph is marked clipped (the strip shows)', () => {
    render(<GraphView graph={wideGraph} repoId="/repo" />);
    fireEvent.keyDown(screen.getByRole('separator', { name: /Graph/ }), { key: 'ArrowLeft' });
    expect(cellW('graph')).toBe(need - 8);
    expect(canvas()).toHaveAttribute('data-clipped', 'true');
  });

  it('a refresh with fewer lanes clamps a wider chosen width to the new max, and more lanes bring it back (no jump)', () => {
    useColumnPrefs.getState().loadFor('/repo');
    useColumnPrefs.getState().setWidth('graph', 400);
    const { rerender } = render(<GraphView graph={wideGraph} repoId="/repo" />);
    expect(cellW('graph')).toBe(400);
    expect(canvas()).toHaveAttribute('data-clipped', 'true');
    // Load more / refresh: 10 lanes need 10 * 22 + 2 * 11 = 242 px, below the chosen 400.
    rerender(<GraphView graph={{ ...wideGraph, maxLanes: 10 }} repoId="/repo" />);
    expect(cellW('graph')).toBe(10 * METRICS.laneW + 2 * METRICS.padX);
    expect(canvas()).toHaveAttribute('data-clipped', 'false');
    // Still within the new max: the user's width is kept as is.
    rerender(<GraphView graph={{ ...wideGraph, maxLanes: 30 }} repoId="/repo" />);
    expect(cellW('graph')).toBe(400);
    expect(useColumnPrefs.getState().prefs.graph).toBe(400);
  });
});
