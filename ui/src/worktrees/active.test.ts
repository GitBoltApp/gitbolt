import { describe, expect, it } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import { withActive, withActiveSidebar } from './active';

const wt = (path: string, branch: string | null, head: string, isMain = false) => ({ path, branch, head, isMain, locked: false, inProgress: null });
const label = (row: number, name: string, checkedOut: string | null, isHead = false) =>
  ({ row, name, local: `refs/heads/${name}`, remotes: [], tag: false, isHead, worktree: null, checkedOut });

const graph = (): GraphPayload => ({
  rows: [{ id: 'wip:/r' }, { id: 'aaa' }, { id: 'bbb' }, { id: 'ccc' }] as GraphPayload['rows'],
  labels: [label(1, 'main', '/r', true), label(2, 'x', '/r-x'), label(3, 'y', null)],
  maxLanes: 1, pinnedRef: null, truncated: false,
  head: { branch: 'refs/heads/main', target: 'aaa', detached: false, unborn: false },
  openWorktree: '/r',
  worktrees: [wt('/r', 'refs/heads/main', 'aaa', true), wt('/r-x', 'refs/heads/x', 'bbb'), wt('/r-d', null, 'ccc')],
} as unknown as GraphPayload);

describe('withActive (spec #2 §11.2)', () => {
  it('moves the HEAD marker and the elsewhere chips to the active worktree', () => {
    const g = withActive(graph(), '/r-x');
    expect(g.head).toEqual({ branch: 'refs/heads/x', target: 'bbb', detached: false, unborn: false });
    expect(g.openWorktree).toBe('/r-x');
    const by = Object.fromEntries(g.labels.map((l) => [l.name, l]));
    expect([by.main.isHead, by.main.worktree]).toEqual([false, '/r']);
    expect([by.x.isHead, by.x.worktree]).toEqual([true, null]);
    expect([by.y.isHead, by.y.worktree]).toEqual([false, null]);
    expect(g.rows).toEqual(graph().rows);
  });
  it('a detached worktree gets the HEAD chip at its commit', () => {
    const g = withActive(graph(), '/r-d');
    expect(g.head.detached).toBe(true);
    const head = g.labels.find((l) => l.name === 'HEAD');
    expect(head).toMatchObject({ row: 3, isHead: true, local: null });
    expect(withActive(g, '/r').labels.some((l) => l.name === 'HEAD')).toBe(false);
  });
  it('is the same object for the same graph and path', () => {
    const g = graph();
    expect(withActive(g, '/r-x')).toBe(withActive(g, '/r-x'));
  });
});

describe('withActiveSidebar', () => {
  it('re-marks the current branch and worktree', () => {
    const s = {
      locals: [{ name: 'main', fullName: 'refs/heads/main', isHead: true, worktree: null, checkedOut: '/r' }, { name: 'x', fullName: 'refs/heads/x', isHead: false, worktree: '/r-x', checkedOut: '/r-x' }],
      worktrees: [{ path: '/r', isCurrent: true }, { path: '/r-x', isCurrent: false }],
      remotes: [], stashes: [], tags: [],
    } as unknown as SidebarPayload;
    const out = withActiveSidebar(s, '/r-x');
    expect(out.locals.map((b) => [b.isHead, b.worktree])).toEqual([[false, '/r'], [true, null]]);
    expect(out.worktrees.map((w) => w.isCurrent)).toEqual([false, true]);
  });
});
