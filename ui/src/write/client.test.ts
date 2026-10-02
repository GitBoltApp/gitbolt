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
const { journalKey, useJournal } = await import('../undo/store');

const ctx = { tabId: 't', repoId: 4, worktree: '/r' };
const journal = { undo: { entry: 1, label: 'commit "x"', kind: 'commit' as const }, redo: null, undoBlocked: null, redoBlocked: 'Nothing to redo', banners: [] };
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
    const send = vi.fn(async (_: boolean, asked: { autostash: boolean; withoutIndex: boolean }) => {
      if (!asked.autostash) throw conflict;
      if (!asked.withoutIndex) throw withoutIndex;
      return result('both');
    });
    expect(await runWrite(ctx, send)).toBe('both');
    expect(send.mock.calls.map((c) => c[1])).toEqual([{ autostash: false, withoutIndex: false }, { autostash: true, withoutIndex: false }, { autostash: true, withoutIndex: true }]);
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
});
