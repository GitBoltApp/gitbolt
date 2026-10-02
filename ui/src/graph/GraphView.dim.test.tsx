import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { GraphView } from './GraphView';
import { BRANCH_FOCUS_DELAY_MS, dimAllBut, ROW_DIM_CLASS, rowDimKindClass } from './rowDim';

vi.mock('./GraphCanvas', () => ({ GraphCanvas: () => null }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));
// Counts row renders: every commit row formats its date once per render.
const renders = vi.hoisted(() => ({ byTime: new Map<number, number>() }));
vi.mock('../format/date', async (importOriginal) => {
  const real = await importOriginal<typeof import('../format/date')>();
  return { ...real, formatDate: (t: number) => { renders.byTime.set(t, (renders.byTime.get(t) ?? 0) + 1); return real.formatDate(t); } };
});
HTMLCanvasElement.prototype.getContext = (() => null) as never;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });

// M merges feat (F2 <- F1) into main (M <- A <- B). Row i's committerTime is i, to count renders.
const row = (i: number, id: string, lane: number, parents: string[]): RowPayload => ({ id, kind: parents.length > 1 ? 'merge' : 'commit', lane, color: lane, segments: [], summary: `commit ${id}`, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: i, parents, mrRefs: [], wip: null });
const local = (r: number, name: string): RefLabel => ({ row: r, name, local: `refs/heads/${name}`, remotes: [], tag: false, isHead: false, worktree: null, checkedOut: null });
const graph: GraphPayload = {
  rows: [row(0, 'M', 0, ['A', 'F2']), row(1, 'F2', 1, ['F1']), row(2, 'A', 0, ['B']), row(3, 'F1', 1, ['B']), row(4, 'B', 0, [])],
  labels: [local(0, 'main'), local(1, 'feat'), { row: 4, name: 'v1', local: null, remotes: [], tag: true, isHead: false, worktree: null, checkedOut: null }],
  maxLanes: 2, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [],
};

const TEXT_COLS = ['message', 'author', 'date', 'sha'];
/** Per row, whether its text cells are dimmed (all four agree, or this throws). */
const dimmedRows = () => screen.getAllByRole('row').map((r, i) => {
  const cells = TEXT_COLS.map((c) => r.querySelector(`[data-col="${c}"]`)!.classList.contains(ROW_DIM_CLASS));
  if (cells.some((d) => d !== cells[0])) throw new Error(`row ${i}: text cells disagree`);
  // Never the Branch/Tag or Graph cells.
  for (const c of ['labels', 'graph']) if (r.querySelector(`[data-col="${c}"]`)!.classList.contains(ROW_DIM_CLASS)) throw new Error(`row ${i}: ${c} dimmed`);
  return cells[0];
});
/** Per row, its dim level ('branch' | 'filter'), or false: the kind class (rowDimKindClass)
 * every text cell must agree on, alongside the shared ROW_DIM_CLASS. */
const dimKinds = () => screen.getAllByRole('row').map((r, i) => {
  const kinds = TEXT_COLS.map((c) => {
    const el = r.querySelector(`[data-col="${c}"]`)!;
    return (['branch', 'filter'] as const).find((k) => el.classList.contains(rowDimKindClass(k))) ?? false;
  });
  if (kinds.some((k) => k !== kinds[0])) throw new Error(`row ${i}: dim kinds disagree`);
  return kinds[0];
});
const chip = (name: string) => screen.getByText(name, { selector: '.ref-name' }).closest('.ref-label')!;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('branch-hover focus (J22)', () => {
  it("after 500 ms on a branch chip, the text cells of every row outside that branch dim; leaving clears it at once", () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    expect(dimmedRows()).toEqual([false, false, false, false, false]);
    fireEvent.mouseEnter(chip('feat'));
    act(() => vi.advanceTimersByTime(BRANCH_FOCUS_DELAY_MS - 1));
    expect(dimmedRows()).toEqual([false, false, false, false, false]);
    act(() => vi.advanceTimersByTime(1));
    // feat: its tip (1) and F1 (3), the rows the membership claims for it.
    expect(dimmedRows()).toEqual([true, false, true, false, true]);
    // Branch-hover dims at the 'branch' level (the lighter, 50%-white token).
    expect(dimKinds()).toEqual(['branch', false, 'branch', false, 'branch']);
    fireEvent.mouseLeave(chip('feat'));
    expect(dimmedRows()).toEqual([false, false, false, false, false]);
  });

  it('leaving before the delay focuses nothing; a tag chip focuses nothing', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    fireEvent.mouseEnter(chip('main'));
    act(() => vi.advanceTimersByTime(300));
    fireEvent.mouseLeave(chip('main'));
    act(() => vi.advanceTimersByTime(1000));
    expect(dimmedRows()).toEqual([false, false, false, false, false]);
    fireEvent.mouseEnter(chip('v1'));
    act(() => vi.advanceTimersByTime(1000));
    expect(dimmedRows()).toEqual([false, false, false, false, false]);
  });

  it("main's focus: its first-parent claims, not feat's commits", () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    fireEvent.mouseEnter(chip('main'));
    act(() => vi.advanceTimersByTime(BRANCH_FOCUS_DELAY_MS));
    expect(dimmedRows()).toEqual([false, true, false, true, false]);
  });

  it('memo-safe: only the rows whose dim state changes re-render', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const snapshot = () => graph.rows.map((_, i) => renders.byTime.get(i) ?? 0);
    const before = snapshot();
    fireEvent.mouseEnter(chip('feat'));
    act(() => vi.advanceTimersByTime(BRANCH_FOCUS_DELAY_MS));
    const focused = snapshot();
    expect(focused.map((n, i) => n - before[i])).toEqual([1, 0, 1, 0, 1]);
    fireEvent.mouseLeave(chip('feat'));
    expect(snapshot().map((n, i) => n - focused[i])).toEqual([1, 0, 1, 0, 1]);
  });

  it("an external RowDim (plan 1C's Ctrl+F) uses the same mechanism at the 'filter' level (the dimmer, 20%-white token), and a new predicate dimming the same rows at the same level re-renders nothing", () => {
    const { rerender } = render(<GraphView graph={graph} repoId="/repo" rowDim={dimAllBut(new Set([0, 2]), 'filter')} />);
    expect(dimmedRows()).toEqual([false, true, false, true, true]);
    expect(dimKinds()).toEqual([false, 'filter', false, 'filter', 'filter']);
    const before = graph.rows.map((_, i) => renders.byTime.get(i) ?? 0);
    rerender(<GraphView graph={graph} repoId="/repo" rowDim={dimAllBut(new Set([0, 2]), 'filter')} />);
    expect(graph.rows.map((_, i) => (renders.byTime.get(i) ?? 0) - before[i])).toEqual([0, 0, 0, 0, 0]);
    rerender(<GraphView graph={graph} repoId="/repo" rowDim={null} />);
    expect(dimmedRows()).toEqual([false, false, false, false, false]);
  });

  it("with both, each row takes the stronger level: Find's non-matches stay at 'filter', and the branch hover dims the matches outside that branch at 'branch'", () => {
    // Find keeps rows 0–2; feat claims rows 1 and 3.
    render(<GraphView graph={graph} repoId="/repo" rowDim={dimAllBut(new Set([0, 1, 2]), 'filter')} />);
    const snapshot = () => graph.rows.map((_, i) => renders.byTime.get(i) ?? 0);
    const before = snapshot();
    fireEvent.mouseEnter(chip('feat'));
    act(() => vi.advanceTimersByTime(BRANCH_FOCUS_DELAY_MS));
    expect(dimKinds()).toEqual(['branch', false, 'branch', 'filter', 'filter']);
    // Memo-safe: only the two rows whose level changed re-rendered.
    expect(snapshot().map((n, i) => n - before[i])).toEqual([1, 0, 1, 0, 0]);
    fireEvent.mouseLeave(chip('feat'));
    expect(dimKinds()).toEqual([false, false, false, 'filter', 'filter']);
  });
});
