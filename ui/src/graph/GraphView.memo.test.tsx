import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { GraphView } from './GraphView';

// Counts label-cell renders: a proxy for "did the virtual row re-render".
const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock('./RefLabels', () => ({ RefLabels: () => { renders.n++; return null; } }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));

HTMLCanvasElement.prototype.getContext = (() => null) as never;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });

const row = (i: number) => ({ id: String(i).padStart(40, '0'), kind: 'commit' as const, lane: 0, color: 0, segments: [], summary: `c${i}`, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], wip: null });
const graph: GraphPayload = {
  rows: [row(0), row(1), row(2)], labels: [], maxLanes: 1, pinnedRef: null,
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
