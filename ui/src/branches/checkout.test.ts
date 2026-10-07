import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useRuntime } from '../app/runtime';
import * as confirm from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast';
import * as active from '../worktrees/active';
import { checkout, checkoutLabel, checkoutSideItem } from './checkout';
import { useTabViews } from '../app/tabStores';
import { resetTo } from './reset';
import { usePending } from '../pending/store';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const done = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null });
const target = { kind: 'remote' as const, remote: 'origin', branch: 'feature/x' };
const expectNone = { head: null, refs: {} };
const diverged = { status: 'diverged', local: 'feature/x', remote: 'origin/feature/x', ahead: 2, behind: 3, localOid: 'l1', remoteOid: 'r1' };

describe('checkout (spec #2 §9.3)', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('asks on divergence and resets on Reset, pinning both refs to the oids shown', async () => {
    const call = vi.spyOn(api, 'checkout')
      .mockResolvedValueOnce(done(diverged) as never)
      .mockResolvedValueOnce(done({ status: 'done', branch: 'feature/x' }) as never);
    const ask = vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true);
    await checkout(ctx, target, { head: 'h0', refs: {} });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Branches have diverged', body: 'feature/x and origin/feature/x have diverged (2 ahead, 3 behind).', confirmLabel: 'Reset to remote', arm: 'Click again to reset (drops 2 local commits)', danger: true }), null);
    expect(call).toHaveBeenLastCalledWith(1, '/r', target, { head: 'h0', refs: { 'refs/heads/feature/x': 'l1', 'refs/remotes/origin/feature/x': 'r1' } }, false, 'reset');
  });
  it("the spinner hands straight over to the checkmark: it stays until the refreshed graph and sidebar arrive", async () => {
    useRuntime.getState().patch('t', { graph: { worktrees: [] } as never, sidebar: { locals: [] } as never });
    vi.spyOn(api, 'checkout').mockResolvedValue(done({ status: 'done', branch: 'feature/x' }) as never);
    const pendingOf = () => usePending.getState().byTab.t?.['refs/heads/feature/x'] ?? null;
    let finished = false;
    const run = checkout(ctx, { kind: 'branch', name: 'feature/x' }, expectNone).then(() => { finished = true; });
    await vi.waitFor(() => expect(api.checkout).toHaveBeenCalled());
    await Promise.resolve();
    expect(pendingOf()).toBe('checkout');
    expect(finished).toBe(false);
    // The refresh lands: a new graph and sidebar showing the new HEAD.
    useRuntime.getState().patch('t', { graph: { worktrees: [] } as never, sidebar: { locals: [] } as never });
    await run;
    expect(pendingOf()).toBeNull();
  });
  it('Cancel leaves it', async () => {
    vi.spyOn(api, 'checkout').mockResolvedValueOnce(done(diverged) as never);
    vi.spyOn(confirm, 'confirmAction').mockResolvedValue(false);
    await checkout(ctx, target, expectNone);
    expect(api.checkout).toHaveBeenCalledTimes(1);
  });
  it('a branch checked out elsewhere offers Switch to it and Open in a new tab', async () => {
    useRuntime.getState().patch('t', { graph: { worktrees: [{ path: '/r-x', branch: 'refs/heads/feature/x', head: 'b', isMain: false, locked: false, inProgress: null }] } as never });
    vi.spyOn(api, 'checkout').mockRejectedValue({ kind: 'InvalidInput', message: 'feature/x is checked out in ../r-x.', commandId: null, stderr: null, detail: { kind: 'checkedOutElsewhere', branch: 'feature/x', worktree: '../r-x' } });
    const sw = vi.spyOn(active, 'setActiveWorktree').mockImplementation(() => {});
    await checkout(ctx, { kind: 'branch', name: 'feature/x' }, expectNone);
    const t = useToast.getState();
    expect(t.message).toBe('feature/x is checked out in ../r-x.');
    expect(t.actions.map((a) => a.label)).toEqual(['Switch to it', 'Open in a new tab']);
    t.actions[0].run();
    expect(sw).toHaveBeenCalledWith('t', '/r-x');
  });
  it('double-clicking a branch checked out in another worktree switches to that worktree, with no checkout', () => {
    useRuntime.getState().patch('t', { repo: { id: 1, path: '/r' }, worktree: '/r' } as never);
    const sw = vi.spyOn(active, 'setActiveWorktree').mockImplementation(() => {});
    const call = vi.spyOn(api, 'checkout');
    const branch = { name: 'feature/x', fullName: 'refs/heads/feature/x', isHead: false, worktree: '/r-x' };
    checkoutSideItem({ tabId: 't', store: null as never }, { kind: 'local', target: 'b', branch } as never);
    expect(sw).toHaveBeenCalledWith('t', '/r-x');
    const store = {} as never;
    useTabViews.setState({ views: { t: { store } as never } });
    const label = { row: 0, name: 'feature/x', local: 'refs/heads/feature/x', remotes: [], tag: false, isHead: false, worktree: '/r-x', checkedOut: '/r-x' };
    expect(checkoutLabel(store, { id: 'b' } as never, label)).toBe(true);
    expect(sw).toHaveBeenCalledTimes(2);
    expect(call).not.toHaveBeenCalled();
    useTabViews.setState({ views: {} });
  });
  it('a repository in the way is a refusal: readable, with no Retry and nothing to force', async () => {
    vi.spyOn(api, 'checkout').mockRejectedValue({ kind: 'InvalidInput', message: 'sm is a repository in the way of the checkout: move it first', commandId: null, stderr: null, detail: null });
    await checkout(ctx, { kind: 'branch', name: 'x' }, expectNone);
    const t = useToast.getState();
    expect(t.message).toBe("A repository is in the way: sm can't be replaced during the checkout: move it first");
    expect(t.actions.map((a) => a.label)).not.toContain('Retry');
    expect(api.checkout).toHaveBeenCalledTimes(1);
  });
});

describe('reset (spec #2 §9.4)', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('a hard reset over changes asks, then resends with discard', async () => {
    const call = vi.spyOn(api, 'reset')
      .mockRejectedValueOnce({ kind: 'DirtyWorktree', message: 'Reset main to a1b2c3d and discard changes to 2 files? You can undo this.', commandId: null, stderr: null, detail: { kind: 'resetDiscards', branch: 'main', to: 'a1b2c3d', files: 2 } })
      .mockResolvedValueOnce(done(null) as never);
    const ask = vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true);
    await resetTo(ctx, 'abc', 'hard', 'h0');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ body: 'Reset main to a1b2c3d and discard changes to 2 files? You can undo this.', danger: true }), null);
    expect(call).toHaveBeenNthCalledWith(1, 1, '/r', 'abc', 'hard', { head: 'h0', refs: {} }, false);
    expect(call).toHaveBeenNthCalledWith(2, 1, '/r', 'abc', 'hard', { head: 'h0', refs: {} }, true);
  });
  it('a repository in the way is a refusal, never offered to force', async () => {
    const call = vi.spyOn(api, 'reset').mockRejectedValue({ kind: 'InvalidInput', message: 'sm is a repository in the way of the reset: move it first', commandId: null, stderr: null, detail: null });
    const ask = vi.spyOn(confirm, 'confirmAction');
    await resetTo(ctx, 'abc', 'hard', 'h0');
    expect(ask).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
    expect(useToast.getState().message).toContain("sm can't be replaced during the reset: move it first");
  });
});
