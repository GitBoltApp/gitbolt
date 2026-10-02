import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useAppState } from '../app/state';
import { useRuntime } from '../app/runtime';
import * as confirm from '../ui/ConfirmDialog';
import * as active from './active';
import { removeWorktree } from './remove';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const res = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null });

describe('Remove worktree (spec #2 §11.1)', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('always confirms, and asks again before forcing', async () => {
    const ask = vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true);
    const rm = vi.spyOn(api, 'worktreeRemove').mockResolvedValueOnce(res({ status: 'needsForce', reason: "It has changes that aren't committed" }) as never).mockResolvedValueOnce(res({ status: 'removed' }) as never);
    useRuntime.getState().patch('t', { repo: { id: 1, path: '/r', name: 'r', worktree: '/r' }, worktree: '/r', graph: { worktrees: [{ path: '/r', isMain: true }, { path: '/r-x', isMain: false }] } as never });
    await removeWorktree(ctx, '/r-x', 'x');
    expect(ask.mock.calls[0][0]).toMatchObject({ body: 'Remove worktree ../r-x? Its folder is deleted; branch x stays.', confirmLabel: 'Remove', danger: true });
    expect(ask.mock.calls[1][0].body).toBe("../r-x has changes that aren't committed. Remove it anyway? They're lost: this can't be undone.");
    expect(rm).toHaveBeenLastCalledWith(1, '/r', '/r-x', true);
  });
  it('a tab whose active worktree it is moves to the main worktree first (Review Focus 5)', async () => {
    vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true);
    vi.spyOn(api, 'worktreeRemove').mockResolvedValue(res({ status: 'removed' }) as never);
    const sw = vi.spyOn(active, 'setActiveWorktree').mockImplementation(() => {});
    useAppState.getState().setProfile({ ...useAppState.getState().profile, tabs: [{ id: 'u', kind: 'repo', path: '/r', alias: null, worktree: '/r-x' }] });
    useRuntime.getState().patch('u', { repo: { id: 1, path: '/r', name: 'r', worktree: '/r-x' }, worktree: '/r-x', graph: { worktrees: [{ path: '/r', isMain: true }, { path: '/r-x', isMain: false }] } as never });
    await removeWorktree(ctx, '/r-x', 'x');
    expect(sw).toHaveBeenCalledWith('u', '/r');
  });
  it('with a tab already on main, the removed worktree\'s own tab is closed, not left on a deleted folder', async () => {
    vi.restoreAllMocks();
    vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true);
    vi.spyOn(api, 'worktreeRemove').mockResolvedValue(res({ status: 'removed' }) as never);
    useAppState.getState().setProfile({ ...useAppState.getState().profile, activeTab: 't', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null, worktree: '/r' }, { id: 'u', kind: 'repo', path: '/r', alias: null, worktree: '/r-x' }] });
    const graph = { worktrees: [{ path: '/r', isMain: true }, { path: '/r-x', isMain: false }] } as never;
    useRuntime.getState().patch('t', { repo: { id: 1, path: '/r', name: 'r', worktree: '/r' }, worktree: '/r', graph });
    useRuntime.getState().patch('u', { repo: { id: 1, path: '/r', name: 'r', worktree: '/r-x' }, worktree: '/r-x', graph });
    await removeWorktree(ctx, '/r-x', 'x');
    expect(useAppState.getState().profile.tabs.map((t) => t.id)).toEqual(['t']);
  });
  it('a failed remove puts the moved tab back', async () => {
    vi.restoreAllMocks();
    vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true);
    vi.spyOn(api, 'worktreeRemove').mockRejectedValue(new Error('nope'));
    const sw = vi.spyOn(active, 'setActiveWorktree').mockImplementation(() => {});
    useAppState.getState().setProfile({ ...useAppState.getState().profile, tabs: [{ id: 'u', kind: 'repo', path: '/r', alias: null, worktree: '/r-x' }] });
    useRuntime.getState().patch('u', { repo: { id: 1, path: '/r', name: 'r', worktree: '/r-x' }, worktree: '/r-x', graph: { worktrees: [{ path: '/r', isMain: true }, { path: '/r-x', isMain: false }] } as never });
    await removeWorktree(ctx, '/r-x', 'x');
    expect(sw).toHaveBeenLastCalledWith('u', '/r-x');
  });
});
