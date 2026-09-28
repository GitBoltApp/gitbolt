import { fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { RepoView } from '../repo/RepoView';
import { fakeServices } from '../repo/testServices';
import { GraphView } from './GraphView';

// Counts label-cell renders: a proxy for "did the virtual row re-render".
const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock('./RefLabels', () => ({ RefLabels: () => { renders.n++; return null; } }));
// Counts GraphView renders (the canvas re-renders with the view; it isn't memoized).
const views = vi.hoisted(() => ({ n: 0 }));
vi.mock('./GraphCanvas', () => ({ GraphCanvas: () => { views.n++; return null; } }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));
// Counts how often the per-graph branch membership (F7) is computed.
const membershipCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('./membership', async (importOriginal) => {
  const real = await importOriginal<typeof import('./membership')>();
  return { ...real, branchMembership: (...a: Parameters<typeof real.branchMembership>) => { membershipCalls.n++; return real.branchMembership(...a); } };
});

HTMLCanvasElement.prototype.getContext = (() => null) as never;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });

const row = (i: number) => ({ id: String(i).padStart(40, '0'), kind: 'commit' as const, lane: 0, color: 0, segments: [], summary: `c${i}`, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graph: GraphPayload = {
  rows: [row(0), row(1), row(2), row(3)], labels: [], maxLanes: 1, pinnedRef: null,
  head: { branch: null, target: null, detached: false, unborn: false }, truncated: false,
};

describe('GraphView virtual rows', () => {
  it('are memoized: a scroll event re-renders the view but not the rows', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    const before = renders.n;
    expect(before).toBeGreaterThan(0);
    grid.scrollTop = 5;
    fireEvent.scroll(grid);
    grid.scrollTop = 9;
    fireEvent.scroll(grid);
    expect(renders.n).toBe(before);
  });

  it('still re-render the rows whose selection changed', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const before = renders.n;
    fireEvent.mouseDown(screen.getAllByRole('row')[1]);
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'true');
    expect(renders.n - before).toBe(1);
  });
});

/** A parent that owns the selection, with a stable callback (as RepoView's store action is). */
function Controlled({ graph: g = graph }: { graph?: GraphPayload }) {
  const [selected, setSelected] = useState(-1);
  const onSelect = useCallback((i: number) => setSelected(i), []);
  return <GraphView graph={g} repoId="/repo" selected={selected} onSelect={onSelect} />;
}

describe('GraphView virtual rows, controlled selection', () => {
  it('moving the selection re-renders only the old and the new row', () => {
    render(<Controlled />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseDown(screen.getAllByRole('row')[1]);
    const before = renders.n;
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.getAllByRole('row')[2]).toHaveAttribute('aria-selected', 'true');
    expect(renders.n - before).toBe(2);
  });

  it('inside RepoView (store-driven): Up/Down and a Ctrl+click compare touch only the rows that changed', () => {
    render(<RepoView repo={1} repoPath="/repo" graph={graph} services={fakeServices()} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.mouseDown(screen.getAllByRole('row')[1]);
    let before = renders.n;
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.getAllByRole('row')[2]).toHaveAttribute('aria-selected', 'true');
    expect(renders.n - before).toBe(2);
    before = renders.n;
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(renders.n - before).toBe(2);
    // Row 1 is selected: Ctrl+click it (mark A, stays selected), then Ctrl+click row 3 (mark B,
    // and the selection moves there): rows 1 and 3 re-render, rows 0 and 2 don't.
    fireEvent.mouseDown(screen.getAllByRole('row')[1], { ctrlKey: true });
    before = renders.n;
    fireEvent.mouseDown(screen.getAllByRole('row')[3], { ctrlKey: true });
    expect(screen.getByTestId('compare-b')).toBeInTheDocument();
    expect(renders.n - before).toBe(2);
  });
});

describe('GraphView virtual rows, hover-driven branch membership chip (F7)', () => {
  // A linear history under `main`: rows 1..3 aren't the tip, so hovering them shows the chip.
  const chained: GraphPayload = {
    ...graph,
    rows: graph.rows.map((r, i) => ({ ...r, parents: i + 1 < graph.rows.length ? [graph.rows[i + 1].id] : [] })),
    labels: [{ row: 0, name: 'main', local: 'refs/heads/main', remotes: [], tag: false, isHead: true, worktree: null }],
  };

  it('hovering re-renders only the rows whose chip appears or goes, and the mapping is computed once per graph', () => {
    const calls0 = membershipCalls.n;
    const { rerender } = render(<Controlled graph={chained} />);
    const rows = () => screen.getAllByRole('row');
    let before = renders.n;
    fireEvent.mouseEnter(rows()[2]);
    expect(renders.n - before).toBe(1);
    before = renders.n;
    fireEvent.mouseLeave(rows()[2]);
    fireEvent.mouseEnter(rows()[3]);
    expect(renders.n - before).toBe(2);
    // Onto the tip (no chip there): only the row losing its chip re-renders.
    before = renders.n;
    fireEvent.mouseLeave(rows()[3]);
    fireEvent.mouseEnter(rows()[0]);
    expect(renders.n - before).toBe(1);
    // Selecting the hovered row: its chip is already shown, so only the selection re-renders it.
    fireEvent.mouseLeave(rows()[0]);
    fireEvent.mouseEnter(rows()[1]);
    before = renders.n;
    fireEvent.mouseDown(rows()[1]);
    expect(renders.n - before).toBe(1);
    // Leaving the selected row keeps its chip: no re-render.
    before = renders.n;
    fireEvent.mouseLeave(rows()[1]);
    expect(renders.n - before).toBe(0);
    // Scrolling doesn't touch it either.
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    grid.scrollTop = 5;
    fireEvent.scroll(grid);
    expect(renders.n - before).toBe(0);
    expect(membershipCalls.n - calls0).toBe(1);
    rerender(<Controlled graph={chained} />);
    expect(membershipCalls.n - calls0).toBe(1);
  });
});

describe('GraphView, hover crossings (F7)', () => {
  it('moving the pointer over rows with no membership chip doesn\'t even re-render the view', () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const rows = screen.getAllByRole('row');
    const before = views.n;
    const rowsBefore = renders.n;
    for (let i = 0; i < rows.length; i++) {
      fireEvent.mouseEnter(rows[i]);
      fireEvent.mouseLeave(rows[i]);
    }
    expect(views.n - before).toBe(0);
    expect(renders.n - rowsBefore).toBe(0);
  });
});
