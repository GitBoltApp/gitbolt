import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GbError } from '../api/gen/GbError';
import type { WriteResult } from '../api/gen/WriteResult';

const fresh = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('../api/client', () => ({ api: { journalState: async () => fresh.state }, errorMessage: String, onEvent: () => () => {} }));
const confirm = vi.hoisted(() => ({ answer: true, asked: [] as Array<{ title: string; body: string }> }));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: vi.fn(async (r: { title: string; body: string }) => { confirm.asked.push(r); return confirm.answer; }) }));
const toast = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('../debug/errorToast', () => ({ toastActionError: (e: unknown, ctx: unknown) => toast.calls.push({ e, ctx }) }));
const put = vi.hoisted(() => vi.fn());
vi.mock('../app/tabStores', () => ({ tabView: () => ({ services: { wip: { put } } }) }));

const { runWrite } = await import('./client');
const { useToast } = await import('../ui/toast');
const { journalKey, useJournal } = await import('../undo/store');

const ctx = { tabId: 't', repoId: 4, worktree: '/r' };
const journal = { undo: { entry: 1, label: 'commit "x"', kind: 'commit' as const }, redo: null, undoBlocked: null, redoBlocked: 'Nothing to redo', banners: [], paused: null };
const result = (outcome: string): WriteResult<string> => ({ outcome, journal, staging: { undo: null, redo: null, off: null }, wip: { worktree: '/r', version: 'v9', staged: { files: [], added: 0, deleted: 0 }, unstaged: { files: [], added: 0, deleted: 0 } } });
const conflict: GbError = { kind: 'Conflict', message: 'Your changes conflict with feature/x', commandId: null, stderr: null, detail: { kind: 'autostashConflict', paths: ['a.php', 'b.php', 'c.php'], target: 'feature/x' } };
const withoutIndex: GbError = { kind: 'Conflict', message: 'git couldn\'t restore what was staged', commandId: null, stderr: null, detail: { kind: 'applyWithoutIndex' } };

describe('runWrite (spec #2 §3.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirm.asked = [];
    confirm.answer = true;
    toast.calls = [];
    useJournal.setState({ states: {} });
  });

  it('applies the journal and the fresh lists at once', async () => {
    expect(await runWrite(ctx, async () => result('ok'))).toBe('ok');
    expect(useJournal.getState().states[journalKey(4, '/r')]).toEqual(journal);
    expect(put).toHaveBeenCalledWith('/r', expect.objectContaining({ version: 'v9' }));
  });

  it('asks before an autostash restore that would conflict, then sends again confirmed', async () => {
    const send = vi.fn(async (confirmed: boolean) => { if (!confirmed) throw conflict; return result('done'); });
    confirm.answer = true;
    expect(await runWrite(ctx, send)).toBe('done');
    expect(send.mock.calls.map((c) => c[0])).toEqual([false, true]);
    expect(confirm.asked[0].body).toBe('Your changes to a.php (and 2 more) conflict with feature/x. They\'ll be kept in a stash you can apply afterwards.');
  });

  it('a Stale answer reloads the journal before the toast says "Refreshed"', async () => {
    const stale: GbError = { kind: 'Stale', message: 'Changed since it was shown', commandId: null, stderr: null };
    fresh.state = { ...journal, undo: { entry: 2, label: 'commit "y"', kind: 'commit' as const } };
    expect(await runWrite(ctx, async () => { throw stale; })).toBeNull();
    expect(useJournal.getState().states[journalKey(4, '/r')]).toEqual(fresh.state);
    expect(toast.calls).toHaveLength(1);
  });

  it('a Cancel at that question sends nothing more and says nothing', async () => {
    const send = vi.fn(async () => { throw conflict; });
    confirm.answer = false;
    expect(await runWrite(ctx, send)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(toast.calls).toEqual([]);
  });

  it('each question is asked once, and the answers add up', async () => {
    const send = vi.fn(async (_: boolean, asked: { autostash: boolean; withoutIndex: boolean; discard: boolean }) => {
      if (!asked.autostash) throw conflict;
      if (!asked.withoutIndex) throw withoutIndex;
      return result('both');
    });
    expect(await runWrite(ctx, send)).toBe('both');
    expect(send.mock.calls.map((c) => c[1])).toEqual([{ autostash: false, withoutIndex: false, discard: false, markers: false }, { autostash: true, withoutIndex: false, discard: false, markers: false }, { autostash: true, withoutIndex: true, discard: false, markers: false }]);
    expect(confirm.asked.map((q) => q.title)).toEqual(['Your changes conflict', 'Apply without restoring what was staged?']);
    // The same question again after a yes is a plain failure.
    expect(await runWrite(ctx, async (ok) => { if (ok) throw conflict; throw conflict; })).toBeNull();
    expect(toast.calls).toHaveLength(1);
  });

  it('any other failure goes to the error toast with Retry, Refresh and Remove stale lock', async () => {
    const err: GbError = { kind: 'RefMoved', message: 'main changed outside GitBolt', commandId: null, stderr: null };
    const refresh = vi.fn();
    expect(await runWrite(ctx, async () => { throw err; }, { refresh })).toBeNull();
    const { ctx: given } = toast.calls[0] as { ctx: { retry?: unknown; refresh?: unknown; removeLock?: unknown } };
    expect(given.refresh).toBe(refresh);
    expect(typeof given.retry).toBe('function');
    expect(typeof given.removeLock).toBe('function');
  });

  it('a throwing onSuccess keeps the outcome, shows a plain toast and offers no Retry', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSuccess = vi.fn(async () => { throw new Error('refresh failed'); });
    expect(await runWrite(ctx, async () => result('abc'), { onSuccess })).toBe('abc');
    expect(toast.calls).toEqual([]);
    expect(useToast.getState().message).toContain('refresh failed');
    expect(useToast.getState().actions).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('onSuccess runs on a first success and on a successful Retry from the toast, not on a failure', async () => {
    const err: GbError = { kind: 'HookFailed', message: 'pre-commit hook failed', commandId: null, stderr: null };
    const onSuccess = vi.fn();
    let n = 0;
    expect(await runWrite(ctx, async () => { if (n++ === 0) throw err; return result('abc'); }, { onSuccess })).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
    const { ctx: given } = toast.calls[0] as { ctx: { retry: () => Promise<void> } };
    await given.retry();
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith('abc');
  });
});

// --- 2C T9: the reset question and caller-handled failures ---
describe('runWrite 2C (spec #2 §9.4)', () => {
  beforeEach(() => {
    confirm.asked = [];
    confirm.answer = true;
    toast.calls = [];
  });
  it('asks the hard reset question and resends with discard', async () => {
    const err: GbError = { kind: 'DirtyWorktree', message: 'Reset main to a1b2c3d and discard changes to 4 files? You can undo this.', commandId: null, stderr: null, detail: { kind: 'resetDiscards', branch: 'main', to: 'a1b2c3d', files: 4 } };
    const send = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(result('ok'));
    expect(await runWrite(ctx, send)).toBe('ok');
    expect(confirm.asked).toEqual([{ title: 'Discard changes?', body: 'Reset main to a1b2c3d and discard changes to 4 files? You can undo this.', confirmLabel: 'Reset', danger: true }]);
    expect(send).toHaveBeenLastCalledWith(true, { autostash: false, withoutIndex: false, discard: true, markers: false });
  });
  it('lets the caller handle a failure itself', async () => {
    const err: GbError = { kind: 'InvalidInput', message: 'x is checked out in ../r-x.', commandId: null, stderr: null, detail: { kind: 'checkedOutElsewhere', branch: 'x', worktree: '../r-x' } };
    const handle = vi.fn(() => true);
    expect(await runWrite(ctx, () => Promise.reject(err), { handle })).toBeNull();
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'InvalidInput' }));
    expect(toast.calls).toEqual([]);
  });
  it('a retry after an unrelated failure re-asks the discard question', async () => {
    const reset: GbError = { kind: 'DirtyWorktree', message: 'Reset?', commandId: null, stderr: null, detail: { kind: 'resetDiscards', branch: 'main', to: 'a1b2c3d', files: 4 } };
    const other: GbError = { kind: 'InvalidInput', message: 'boom', commandId: null, stderr: null } as GbError;
    const send = vi.fn().mockRejectedValueOnce(reset).mockRejectedValueOnce(other).mockRejectedValueOnce(reset).mockResolvedValueOnce(result('ok'));
    expect(await runWrite(ctx, send)).toBeNull();
    const retry = (toast.calls[0] as { ctx: { retry: () => Promise<void> } }).ctx.retry;
    await retry();
    expect(confirm.asked).toHaveLength(2);
    expect(send.mock.calls[2][1].discard).toBe(false);
  });
  it('catches a throw in handle: logs and toasts', async () => {
    const err: GbError = { kind: 'InvalidInput', message: 'x', commandId: null, stderr: null } as GbError;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const show = vi.spyOn(useToast.getState(), 'show');
    const handle = vi.fn(() => { throw new Error('bad handler'); });
    expect(await runWrite(ctx, () => Promise.reject(err), { handle })).toBeNull();
    expect(log).toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(expect.stringContaining('bad handler'), expect.anything());
    log.mockRestore();
  });
});
// --- end 2C T9 ---
