import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { GraphView } from './GraphView';

// Counts label-cell renders: a proxy for "did the virtual row re-render".
const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock('./RefLabels', () => ({ RefLabels: () => { renders.n++; return null; } }));
vi.mock('./GraphCanvas', () => ({ GraphCanvas: () => null }));

HTMLCanvasElement.prototype.getContext = (() => null) as never;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });

const base = { lane: 0, color: 0, segments: [], bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [] };

it('typing a WIP draft re-renders neither the other rows nor the WIP row itself', () => {
  const graph: GraphPayload = {
    rows: [
      { ...base, id: 'wip:/r', kind: 'wip', summary: '// WIP', wip: { worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 0 } },
      ...[0, 1, 2].map((i) => ({ ...base, id: String(i).padStart(40, '0'), kind: 'commit' as const, summary: `c${i}`, wip: null })),
    ],
    labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [],
  };
  render(<GraphView graph={graph} repoId="/r" />);
  const before = renders.n;
  expect(before).toBeGreaterThan(0);
  const box = screen.getByPlaceholderText('// WIP');
  for (const v of ['a', 'ab', 'abc']) fireEvent.change(box, { target: { value: v } });
  expect(renders.n).toBe(before);
});
