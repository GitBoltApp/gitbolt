import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphView } from './GraphView';
import { formatDate } from '../format/date';
import { METRICS } from './metrics';
import { COLUMN_MIN, columnPrefsPersistence, SHA_W, useColumnPrefs } from './columns';
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

  it('uses the single-sourced 25px row height for the DOM rows', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    expect(METRICS.rowH).toBe(25);
    for (const r of screen.getAllByRole('row')) expect(r).toHaveStyle({ height: '25px' });
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

  it('renders a keyboard-focusable vertical separator for Branch/Tag, Graph, Author and Date', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const seps = screen.getAllByRole('separator');
    expect(seps.map((s) => s.getAttribute('aria-label'))).toEqual(['Resize Branch / Tag column', 'Resize Graph column', 'Resize Author column', 'Resize Date column']);
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

    fireEvent.keyDown(separator(/Graph/), { key: 'ArrowRight' });
    expect(canvas).toHaveStyle({ width: `${graphW + 8}px` });
    expect(header('graph')).toHaveStyle({ width: `${graphW + 8}px` });
    expect(cell('graph')).toHaveStyle({ width: `${graphW + 8}px` });

    // Author and Date sit right of the flexing Message column, so their handle is their left
    // edge: moving it left (ArrowLeft) widens them.
    fireEvent.keyDown(separator(/Author/), { key: 'ArrowLeft' });
    expect(cell('author')).toHaveStyle({ width: '168px' });
    fireEvent.keyDown(separator(/Date/), { key: 'ArrowRight' });
    expect(cell('date')).toHaveStyle({ width: '162px' });
    expect(header('date')).toHaveStyle({ width: '162px' });
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

  it('gives each separator an aria-valuemax of the available width minus the other columns\' minimums', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const minSum = COLUMN_MIN.labels + COLUMN_MIN.graph + COLUMN_MIN.message + COLUMN_MIN.author + COLUMN_MIN.date + SHA_W;
    for (const [name, col] of [[/Branch/, 'labels'], [/Graph/, 'graph'], [/Author/, 'author'], [/Date/, 'date']] as const) {
      expect(screen.getByRole('separator', { name })).toHaveAttribute('aria-valuemax', String(1200 - (minSum - COLUMN_MIN[col])));
    }
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

describe('GraphView columns while Author/Date are squeezed (clientWidth 790)', () => {
  // Default prefs and a 64 px graph at 790 px: Message at its 160 minimum, Author 140 (pref
  // 160), Date 154 (pref 170). The boundary under the pointer is the one that moves.
  withClientWidth(790);

  it('precondition: squeezed', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    expect([cellW('message'), cellW('author'), cellW('date')]).toEqual([COLUMN_MIN.message, 140, 154]);
  });

  it('Author: ArrowLeft/drag-left hit the Message wall; ArrowRight/drag-right track exactly', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const sep = screen.getByRole('separator', { name: /Author/ });
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect([cellW('author'), cellW('date'), cellW('message')]).toEqual([140, 154, 160]);
    dragBy(sep, -20, () => expect(cellW('author')).toBe(140));
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect([cellW('author'), cellW('date'), cellW('message')]).toEqual([132, 154, 168]);
    const x0 = leftOf('author');
    dragBy(sep, 30, (d) => expect(leftOf('author'), `d=${d}`).toBe(x0 + d));
  });

  it('Date: ArrowLeft/drag-left take width 1:1 from Author (handle under the pointer) until Author is at its minimum', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const sep = screen.getByRole('separator', { name: /Date/ });
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect([cellW('date'), cellW('author'), cellW('message')]).toEqual([162, 132, 160]);
    const x0 = leftOf('date');
    const room = cellW('author') - COLUMN_MIN.author; // 72
    dragBy(sep, -100, (d) => expect(leftOf('date'), `d=${d}`).toBe(x0 - Math.min(-d, room)));
    expect(cellW('author')).toBe(COLUMN_MIN.author);
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(cellW('message')).toBe(168);
  });
});

describe('GraphView: Branch/Tag and Graph wider than columnMax after the window narrowed (clientWidth 1000)', () => {
  withClientWidth(1000);

  for (const [col, name, wide] of [['labels', /Branch/, 700], ['graph', /Graph/, 600]] as const) {
    it(`${col} at ${wide}: ArrowRight and a rightward drag never shrink it; leftward moves track`, () => {
      useColumnPrefs.getState().loadFor('/repo'); // the repo GraphView mounts with, so its load keeps these prefs
      useColumnPrefs.getState().setWidth(col, wide);
      render(<GraphView graph={graph} repoId="/repo" />);
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
