import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';

vi.mock('../api/client', () => ({ api: { avatar: vi.fn(async () => null) } }));
vi.mock('../api/transport', async (orig) => ({ ...(await orig<object>()), copyText: vi.fn(async () => {}) }));

import { TooltipHost } from '../ui/TooltipHost';
import { GraphView } from './GraphView';
import { laneX } from './geometry';
import { METRICS } from './metrics';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
});

const row = (i: number, kind: 'commit' | 'stash') => ({ id: String(i).padStart(40, '0'), kind, lane: 0, color: 0, segments: [], summary: `c${i}`, bodyFirstLine: '', authorName: 'Ada Lovelace', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graph: GraphPayload = {
  rows: [row(0, 'commit'), row(1, 'stash')],
  labels: [{ row: 0, name: 'feat', local: 'refs/heads/feat', remotes: [], tag: false, isHead: false, worktree: null, checkedOut: null }], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [],
};

describe('GraphView node tooltip', () => {
  it('shows Name <email> over a commit node, and hides off it, on scroll and on leave', () => {
    render(<><GraphView graph={graph} repoId="/repo" /><TooltipHost /></>);
    const grid = screen.getByRole('grid');
    const nodeX = parseFloat(screen.getByTestId('graph-canvas').style.left) + laneX(0, METRICS);
    const y = METRICS.rowH / 2;
    const at = (x: number, cy: number) => fireEvent.pointerMove(grid, { clientX: x, clientY: cy });
    at(nodeX, y);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ada Lovelace <ada@example.com>');
    at(nodeX + 40, y);
    expect(screen.queryByRole('tooltip')).toBeNull();
    at(nodeX, y);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.scroll(grid);
    expect(screen.queryByRole('tooltip')).toBeNull();
    at(nodeX, y);
    fireEvent.pointerLeave(grid);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Over a chip (drawn above the node), the chip's tooltip wins: none for the node.
    at(nodeX, y);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerMove(document.querySelector('.ref-label')!, { clientX: nodeX, clientY: y });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A stash row's node gets none.
    at(nodeX, METRICS.rowH * 1.5);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
