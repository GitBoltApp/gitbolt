import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { LocalBranch } from '../api/gen/LocalBranch';
import { useRuntime } from '../app/runtime';
import { useToast } from '../ui/toastStore';
import { afterPushActions, forceText, nothingToPush, openPushUpstream, pushBranch, pushHooks, pushLabel, pushTooltip } from './push';

const confirm = vi.fn(async () => true);
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: (...a: unknown[]) => confirm(...(a as [])) }));
const ask = vi.fn(async (_req: { title: string; body?: string; choices: { id: string; label: string; danger?: boolean; arm?: string; quiet?: boolean }[] }) => ({ choice: null as string | null }));
vi.mock('../ui/ChoiceDialog', () => ({ askChoice: (...a: unknown[]) => ask(...(a as [never])) }));
const target = vi.fn(async () => null as { target: { remote: string; branch: string }; track: boolean } | null);
vi.mock('./PushUpstreamPanel', () => ({ askPushTarget: () => target() }));

const main: LocalBranch = { name: 'main', fullName: 'refs/heads/main', target: 'a'.repeat(40), upstream: 'origin/main', ahead: 1, behind: 0, gone: false, tipTime: 0, summary: '', author: '', isHead: true, worktree: null, checkedOut: null, pushTarget: 'origin/main', pushBehind: 3, rewritten: null };
const ctx = { tabId: 't', repoId: 1, worktree: '/r' };

describe('push (spec #2 §12.3)', () => {
  beforeEach(() => { vi.restoreAllMocks(); useToast.getState().dismiss(); });

  it('the tooltip names the target', () => {
    expect(pushTooltip(main, 'main')).toEqual({ tooltip: 'Push main to origin/main', disabled: false });
    expect(pushTooltip({ ...main, upstream: null, pushTarget: null }, 'main').tooltip).toBe('Push main to origin and track it');
    expect(pushTooltip(undefined, null)).toEqual({ tooltip: 'HEAD is detached', disabled: true });
  });

  it('nothing to push: the upstream is the push target and has every commit', () => {
    expect(nothingToPush({ ...main, ahead: 0 })).toBe(true);
    expect(nothingToPush({ ...main, upstream: 'refs/remotes/origin/main', ahead: 0 })).toBe(true);
    expect(nothingToPush(main)).toBe(false);
    expect(nothingToPush({ ...main, ahead: 0, upstream: null, pushTarget: null })).toBe(false); // publishes it
    expect(nothingToPush({ ...main, ahead: 0, pushTarget: 'fork/main' })).toBe(false); // triangular: unknown
    expect(nothingToPush({ ...main, ahead: 0, gone: true })).toBe(false);
  });

  it('the force confirmation counts what it replaces', () => {
    expect(forceText(main)).toBe("It replaces 3 commits on origin/main that aren't in main. A push can't be undone.");
    expect(forceText({ ...main, pushBehind: 1 })).toContain('It replaces 1 commit on origin/main');
  });

  it('a force with nothing counted does not claim 0 commits; the tooltip names the remote', () => {
    expect(forceText({ ...main, pushBehind: 0 })).toContain('may replace commits on the server');
    expect(forceText({ ...main, pushBehind: null })).not.toContain('0 commits');
    expect(pushTooltip({ ...main, pushTarget: null }, 'main', 'up').tooltip).toBe('Push main to up and track it');
  });

  it('a rejection is a choice: Pull first, then Force push, which arms (board G)', async () => {
    pushHooks.pull = vi.fn();
    vi.spyOn(api, 'push').mockRejectedValue({ kind: 'NonFastForward', message: 'rejected', commandId: 4, stderr: null });
    ask.mockResolvedValueOnce({ choice: 'pull' });
    await pushBranch(ctx, main);
    await vi.waitFor(() => expect(pushHooks.pull).toHaveBeenCalledWith(ctx, 'main'));
    const req = ask.mock.calls[0][0];
    expect(req.title).toBe("origin/main has 3 commits main doesn't have");
    expect(req.body).toBe('Pull them in first, or overwrite them.');
    expect(req.choices.map((c) => c.label)).toEqual(['Pull', 'Force push…', 'Details']);
    expect(req.choices[2]).toMatchObject({ quiet: true });
    expect(req.choices[1]).toMatchObject({ danger: true, arm: 'Click again to force push: replaces 3 commits' });
  });

  it('Force push picked in the popover sends the lease read with the count it showed, without asking again', async () => {
    const sidebar = (oid: string) => ({ tabs: { t: { sidebar: { locals: [main], remotes: [{ name: 'origin', branches: [{ name: 'main', target: oid }] }] } } } } as never);
    useRuntime.setState(sidebar('b'.repeat(40)));
    const push = vi.spyOn(api, 'push').mockRejectedValueOnce({ kind: 'NonFastForward', message: 'rejected', commandId: 4, stderr: null });
    push.mockResolvedValueOnce({ outcome: { remote: 'origin', dst: 'main', branch: 'main', forced: null, upToDate: false, server: [], op: 1 }, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null } as never);
    // A background fetch moves origin/main while the question is up: the lease stays the one shown.
    ask.mockImplementationOnce(async () => { useRuntime.setState(sidebar('c'.repeat(40))); return { choice: 'force' }; });
    confirm.mockClear();
    await pushBranch(ctx, main);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(push.mock.calls[1][3]).toMatchObject({ lease: { oid: 'b'.repeat(40) } });
    expect(confirm).not.toHaveBeenCalled();
    useRuntime.setState({ tabs: {} } as never);
  });

  it('a rejected push from the "Push to" panel (no upstream yet) still offers Force push, to that target, with its lease', async () => {
    // The branch the remote already has (a rebased branch whose upstream was never set here).
    const loose = { ...main, upstream: null, pushTarget: null, pushBehind: null };
    useRuntime.setState({ tabs: { t: { sidebar: { locals: [loose], remotes: [{ name: 'origin', branches: [{ name: 'main', target: 'b'.repeat(40) }] }] } } } } as never);
    target.mockResolvedValueOnce({ target: { remote: 'origin', branch: 'main' }, track: true });
    const push = vi.spyOn(api, 'push').mockRejectedValueOnce({ kind: 'NonFastForward', message: 'rejected', commandId: 4, stderr: null });
    push.mockResolvedValueOnce({ outcome: { remote: 'origin', dst: 'main', branch: 'main', forced: null, upToDate: false, server: [], op: 1 }, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null } as never);
    pushHooks.pull = vi.fn();
    ask.mockClear();
    ask.mockResolvedValueOnce({ choice: 'force' });
    await openPushUpstream(ctx, loose);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    const req = ask.mock.calls[0][0];
    expect(req.title).toBe("origin/main has commits main doesn't have");
    expect(req.choices.map((c) => c.label)).toEqual(['Pull', 'Force push…', 'Details']);
    expect(req.choices[1]).toMatchObject({ danger: true, arm: 'Click again to force push to origin/main' });
    expect(push.mock.calls[1][3]).toMatchObject({ target: { remote: 'origin', branch: 'main' }, setUpstream: true, lease: { oid: 'b'.repeat(40) } });
    useRuntime.setState({ tabs: {} } as never);
  });

  it('a branch rewritten since its last push says Push forces with the lease (spec #2 §12.3)', () => {
    const rebased = { ...main, rewritten: { kind: 'rebase' as const, remote: 'origin' } };
    expect(pushTooltip(rebased, 'main').tooltip).toBe('Push (force with lease: rebased, replaces 3 commits on origin)');
    expect(pushLabel({ ...main, rewritten: { kind: 'amend', remote: 'origin' }, pushBehind: 1 })).toBe('Push (force with lease: amended, replaces 1 commit on origin)');
    // The remote by its real name, even with a slash in it.
    expect(pushLabel({ ...main, pushTarget: 'team/fork/main', rewritten: { kind: 'rebase', remote: 'team/fork' } })).toBe('Push (force with lease: rebased, replaces 3 commits on team/fork)');
    // No force needed (the remote has nothing the branch lacks): the plain tooltip.
    expect(pushLabel({ ...rebased, pushBehind: 0 })).toBe('Push main to origin/main');
    expect(pushLabel({ ...rebased, pushBehind: null })).toBe('Push main to origin/main');
    // Rewritten with nothing ahead: Push stays in the menu, it replaces the remote's commits.
    expect(nothingToPush({ ...main, ahead: 0, rewritten: { kind: 'rebase', remote: 'origin' } })).toBe(false);
    expect(nothingToPush({ ...main, ahead: 0, pushBehind: 3 })).toBe(true);
  });

  it('a force-push with the rewrite lease toasts why', async () => {
    vi.spyOn(api, 'push').mockResolvedValue({ outcome: { op: 9, branch: 'feature/login', remote: 'origin', dst: 'feature/login', upToDate: false, server: { lines: 0, warning: null }, forced: 'rebase' }, journal: { undo: null, redo: null, undoBlocked: "Push can't be undone", redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null } as never);
    await pushBranch(ctx, { ...main, name: 'feature/login', fullName: 'refs/heads/feature/login', rewritten: { kind: 'rebase', remote: 'origin' } });
    expect(useToast.getState().message).toBe('Force-pushed feature/login (with lease): it was rebased');
  });

  it('success toasts the target with the server output link', async () => {
    vi.spyOn(api, 'push').mockResolvedValue({ outcome: { op: 9, branch: 'main', remote: 'origin', dst: 'main', upToDate: false, server: { lines: 1, warning: null }, forced: null }, journal: { undo: null, redo: null, undoBlocked: "Push can't be undone", redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null } as never);
    await pushBranch(ctx, main);
    expect(useToast.getState().message).toBe('Pushed main to origin/main');
    expect(useToast.getState().actions[0].label).toBe('Server output (1 line)');
  });
});

// --- 4C T9 ---
it("a push that created the remote branch adds the hook's link; a later push doesn't", () => {
  const link = { label: 'Create MR', run: vi.fn() };
  pushHooks.afterNewBranch = vi.fn(() => link);
  expect(afterPushActions('t', { ...main, upstream: null, pushTarget: null }, false, 'origin')).toEqual([link]);
  expect(afterPushActions('t', { ...main, pushBehind: null }, false, 'origin')).toEqual([link]);
  expect(afterPushActions('t', main, false, 'origin')).toEqual([]);
  expect(afterPushActions('t', { ...main, pushTarget: null }, true, 'origin')).toEqual([]);
  expect(pushHooks.afterNewBranch).toHaveBeenCalledWith('t', 'main', 'origin');
  pushHooks.afterNewBranch = null;
  expect(afterPushActions('t', { ...main, pushTarget: null }, false, 'origin')).toEqual([]);
});
// --- end 4C T9 ---
