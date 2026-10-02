import { describe, expect, it } from 'vitest';
import { useRuntime } from '../app/runtime';
import { writeCtx } from './ctx';

describe('writeCtx', () => {
  it("is the tab's repo and worktree, or null for a tab without a repo", () => {
    useRuntime.setState({ tabs: { t: { repo: { id: 4, path: '/r', name: 'r' } } } } as never);
    expect(writeCtx('t')).toEqual({ tabId: 't', repoId: 4, worktree: '/r' });
    expect(writeCtx('t', '/r-wt')).toEqual({ tabId: 't', repoId: 4, worktree: '/r-wt' });
    expect(writeCtx('none')).toBeNull();
  });

  it("a linked worktree's tab writes to its active worktree, not the repository's main one (2C T2)", () => {
    useRuntime.setState({ tabs: { t: { repo: { id: 4, path: '/r', name: 'r', worktree: '/r-x' }, worktree: '/r-x' } } } as never);
    expect(writeCtx('t')).toEqual({ tabId: 't', repoId: 4, worktree: '/r-x' });
    expect(writeCtx('t', '/r')).toEqual({ tabId: 't', repoId: 4, worktree: '/r' });
  });
});
