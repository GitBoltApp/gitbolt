// ui/src/stacks/push.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { LocalBranch } from '../api/gen/LocalBranch';
import { useRuntime } from '../app/runtime';
import { useToast } from '../ui/toastStore';
import type { Stack } from './detect';
import { pushStack, pushStackRow, pushSummary } from './push';

const lb = (name: string, over: Partial<LocalBranch> = {}): LocalBranch => ({
  name, fullName: `refs/heads/${name}`, target: name.slice(-1).repeat(40), upstream: `refs/remotes/origin/${name}`, ahead: 1, behind: 0, gone: false, tipTime: 0, summary: '', author: '',
  isHead: false, worktree: null, checkedOut: null, pushTarget: `origin/${name}`, pushBehind: 0, rewritten: null, ...over,
});
const stack: Stack = { branches: ['feature/a', 'feature/b', 'feature/c'], base: 'refs/remotes/origin/main', leftBehind: [] };
const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const ok = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null });
const pushed = (branch: string, over: object = {}) => ok({ op: 1, branch, remote: 'origin', dst: branch, upToDate: false, server: { lines: 0, warning: null }, forced: null, ...over });
const sidebar = (locals: LocalBranch[]) => ({ locals, remotes: [{ name: 'origin', host: null, hostKind: 'generic' as const, branches: [] }], worktrees: [], stashes: [], tags: [] });
const setSidebar = (locals: LocalBranch[]) => useRuntime.setState({ tabs: { t: { repo: { id: 1 }, sidebar: sidebar(locals) } } } as never);
const err = (kind: string, message: string) => ({ kind, message, commandId: 9, stderr: null });

describe('pushStack (spec #3 §3.11)', () => {
  beforeEach(() => { vi.restoreAllMocks(); useToast.getState().dismiss(); });

  it("pushes bottom first: an up-to-date member is skipped; a new one is published to the base's remote and tracked", async () => {
    setSidebar([lb('feature/a', { ahead: 0 }), lb('feature/b', { rewritten: { kind: 'rebase', remote: 'origin' }, pushBehind: 2 }), lb('feature/c', { upstream: null, pushTarget: null, pushBehind: null })]);
    const push = vi.spyOn(api, 'push').mockResolvedValueOnce(pushed('feature/b', { forced: 'rebase' }) as never).mockResolvedValueOnce(pushed('feature/c') as never);
    await pushStack(ctx, stack);
    expect(push.mock.calls.map((c) => c[2])).toEqual(['feature/b', 'feature/c']);
    // The core's push decision forces with the rewrite mark's lease: nothing extra is sent.
    expect(push.mock.calls[0][3]).toEqual({ expect: { head: null, refs: { 'refs/heads/feature/b': 'b'.repeat(40) } } });
    expect(push.mock.calls[1][3]).toEqual({ target: { remote: 'origin', branch: 'feature/c' }, setUpstream: true, expect: { head: null, refs: { 'refs/heads/feature/c': 'c'.repeat(40) } } });
    expect(useToast.getState().message).toBe('Pushed feature/b and feature/c (force with lease: feature/b; new on origin: feature/c)');
  });

  it("a refused member stops the sequence; the toast says which pushed and which didn't (Review Focus 4)", async () => {
    setSidebar([lb('feature/a'), lb('feature/b'), lb('feature/c')]);
    const push = vi.spyOn(api, 'push').mockResolvedValueOnce(pushed('feature/a') as never).mockRejectedValueOnce(err('NonFastForward', "origin/feature/b has commits feature/b doesn't have"));
    await pushStack(ctx, stack);
    expect(push).toHaveBeenCalledTimes(2);
    const t = useToast.getState();
    expect(t.message).toBe('Pushed feature/a; feature/b was refused; not pushed: feature/c');
    expect(t.detail).toBe("origin/feature/b has commits feature/b doesn't have");
    expect(t.actions.map((a) => a.label)).toEqual(['Push feature/b…', 'Details']);
  });

  // --- 4D T6 ---
  it('returns its report, so a caller can chain on it (4D)', async () => {
    setSidebar([lb('feature/a', { ahead: 0 }), lb('feature/b'), lb('feature/c', { ahead: 0 })]);
    vi.spyOn(api, 'push').mockResolvedValueOnce(pushed('feature/b') as never);
    const r = await pushStack(ctx, stack);
    expect(r.failed).toBeNull();
    expect(r.steps.map((s) => [s.name, s.result])).toEqual([['feature/a', 'upToDate'], ['feature/b', 'pushed'], ['feature/c', 'upToDate']]);
  });
  // --- end 4D T6 ---
});

describe('pushStack: warnings and lease rejections', () => {
  beforeEach(() => { vi.restoreAllMocks(); useToast.getState().dismiss(); });
  const warn = (branch: string, w: string) => pushed(branch, { server: { lines: 1, warning: w } });

  it("keeps every pushed member's server warning, also when a later member fails", async () => {
    setSidebar([lb('feature/a'), lb('feature/b'), lb('feature/c')]);
    vi.spyOn(api, 'push').mockResolvedValueOnce(warn('feature/a', 'wa') as never).mockResolvedValueOnce(warn('feature/b', 'wb') as never).mockResolvedValueOnce(warn('feature/c', 'wc') as never);
    await pushStack(ctx, stack);
    expect(useToast.getState().detail).toBe('“wa” “wb” “wc”');
    useToast.getState().dismiss();
    vi.restoreAllMocks();
    vi.spyOn(api, 'push').mockResolvedValueOnce(warn('feature/a', 'wa') as never).mockRejectedValueOnce(err('AuthFailed', 'denied'));
    await pushStack(ctx, stack);
    expect(useToast.getState().detail).toBe('“wa” denied');
  });

  it('offers Push X… for a lease rejection (RefMoved) too', async () => {
    setSidebar([lb('feature/a'), lb('feature/b'), lb('feature/c')]);
    vi.spyOn(api, 'push').mockRejectedValueOnce(err('RefMoved', 'stale info'));
    await pushStack(ctx, stack);
    expect(useToast.getState().actions.map((a) => a.label)).toEqual(['Push feature/a…', 'Details']);
  });
});

describe('pushSummary', () => {
  const report = (over: object) => ({ steps: [], failed: null, rest: [], remote: 'origin', warnings: [], ...over });
  it('up to date, a cancel (no error tone), a refusal with nothing pushed yet', () => {
    expect(pushSummary(report({ steps: [{ name: 'a', result: 'upToDate' }, { name: 'b', result: 'upToDate' }] }))).toEqual({ message: 'The stack is up to date', error: false });
    expect(pushSummary(report({ steps: [{ name: 'a', result: 'pushed' }], failed: { name: 'b', error: err('Cancelled', 'cancelled') }, rest: ['c'] }))).toEqual({ message: 'Pushed a; b was cancelled; not pushed: c', detail: undefined, error: false });
    expect(pushSummary(report({ failed: { name: 'a', error: err('AuthFailed', 'auth') }, rest: ['b'] }))).toEqual({ message: 'a was refused; not pushed: b', detail: 'auth', error: true });
  });
});

describe('pushStackRow (spec #3 §4.3)', () => {
  const t = (name: string) => ({ sha: 's', mrRefs: [], isWip: false, isStash: false, branch: { name, local: `refs/heads/${name}`, remotes: [] } });
  const env = (locals: LocalBranch[], over: object = {}) => ({ stackOf: (b: string) => (stack.branches.includes(b) ? stack : null), sidebar: sidebar(locals), worktreeShown: (p: string) => `../${p.split('/').pop()}`, ...over }) as never;
  const all = [lb('feature/a'), lb('feature/b', { rewritten: { kind: 'rebase', remote: 'origin' }, pushBehind: 1 }), lb('feature/c')];
  const run = vi.fn();

  it('on any member; hidden off the stack, without a remote, or with nothing to push', () => {
    const [row] = pushStackRow(t('feature/a'), env(all), run);
    expect(row).toMatchObject({ kind: 'action', id: 'stack.push', label: 'Push stack', tooltip: 'Push feature/a → feature/b → feature/c, bottom first (force with lease: feature/b)' });
    expect(pushStackRow(t('main'), env(all), run)).toEqual([]);
    expect(pushStackRow(t('feature/a'), env(all, { sidebar: { ...sidebar(all), remotes: [] } }), run)).toEqual([]);
    expect(pushStackRow(t('feature/a'), env(all.map((b) => ({ ...b, ahead: 0, rewritten: null, pushBehind: 0 }))), run)).toEqual([]);
  });

  it('greyed during another operation (a paused stack rebase would push old tips)', () => {
    expect(pushStackRow(t('feature/a'), env(all, { inProgress: 'rebase' }), run)[0]).toMatchObject({ disabledReason: 'Finish or abort the rebase first' });
  });

  it('greyed while a member is checked out in another worktree (§5, Review Focus 2)', () => {
    const away = [lb('feature/a'), lb('feature/b', { worktree: '/w/shop-b' }), lb('feature/c')];
    expect(pushStackRow(t('feature/c'), env(away), run)[0]).toMatchObject({ disabledReason: 'feature/b is checked out in ../shop-b' });
  });
});
