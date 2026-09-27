import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphView } from './GraphView';
import type { GraphPayload } from '../api/gen/GraphPayload';

vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));

HTMLCanvasElement.prototype.getContext = (() => null) as never;

const graph: GraphPayload = {
  rows: [
    { id: 'a'.repeat(40), kind: 'commit', lane: 0, color: 0, segments: [], summary: 'Second', bodyFirstLine: 'details', authorName: 'Ada Lovelace', authorEmail: '', authorTime: 1_767_225_600, parents: ['b'.repeat(40)], wip: null },
    { id: 'b'.repeat(40), kind: 'commit', lane: 0, color: 0, segments: [], summary: 'First', bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: '', authorTime: 1_767_225_000, parents: [], wip: null },
  ],
  labels: [{ row: 0, name: 'main', local: 'refs/heads/main', remotes: [], tag: false, isHead: true, worktree: null }],
  maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: 'a'.repeat(40), detached: false, unborn: false }, truncated: false,
};

describe('GraphView', () => {
  it('renders rows with summary, dimmed body, author and short sha', () => {
    render(<GraphView graph={graph} />);
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('details')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getAllByTestId('sha')[0]).toHaveTextContent('aaaaaa');
  });

  it('arrow keys move the selection', () => {
    render(<GraphView graph={graph} />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.getAllByRole('row')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'true');
  });
});
