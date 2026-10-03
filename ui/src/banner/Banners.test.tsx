import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Banner } from '../api/gen/Banner';

const api = vi.hoisted(() => ({ journalState: vi.fn(), applyKeptStash: vi.fn(), dismissBanner: vi.fn() }));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
const selectCommit = vi.hoisted(() => vi.fn(() => true));
vi.mock('../app/graphNav', () => ({ selectCommit }));
const confirm = vi.hoisted(() => ({ answer: true, asked: [] as Array<{ title: string; body: string }> }));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: vi.fn(async (r: { title: string; body: string }) => { confirm.asked.push(r); return confirm.answer; }) }));
vi.mock('../app/tabStores', () => ({ tabView: () => undefined, tabStore: () => undefined }));
const toast = vi.hoisted(() => ({ calls: [] as Array<{ e: unknown; ctx: { removeLock?: unknown } }> }));
vi.mock('../debug/errorToast', () => ({ toastActionError: (e: unknown, ctx: { removeLock?: unknown }) => toast.calls.push({ e, ctx }) }));

const { Banners } = await import('./Banners');
const { RepoContext } = await import('../app/repoContext');
const { useJournal } = await import('../undo/store');

const tab = { id: 't', kind: 'repo' as const, path: '/r', alias: null };
const base = { entry: 5, label: 'checkout feature/x', stash: 'abc1234def', stashMessage: 'autostash before checkout feature/x', target: 'feature/x', snapshot: false, files: 0, canDrop: false, binary: false };
const state = (banners: Banner[]) => ({ undo: null, redo: null, undoBlocked: 'Nothing to undo', redoBlocked: 'Nothing to redo', banners, paused: null });
const show = (banners: Banner[]) => {
  api.journalState.mockResolvedValue(state(banners));
  act(() => useJournal.getState().set(4, '/r', state(banners)));
  render(<RepoContext value={{ tabId: 't', repoId: 4, path: '/r', worktree: '/r', info: null }}><Banners tab={tab} /></RepoContext>);
};
const wr = (journal = state([])) => ({ outcome: null, journal, staging: { undo: null, redo: null, off: null }, wip: null });
const notices = () => screen.getByRole('region', { name: 'Notices' });

describe('banners (spec #2 §6.4, §5.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirm.answer = true;
    confirm.asked = [];
    toast.calls = [];
    useJournal.setState({ states: {} });
  });

  it('a refused restore: Apply, Show, ×', async () => {
    show([{ ...base, kind: 'autostashRefused' }]);
    expect(notices()).toHaveTextContent('Your changes from before checkout feature/x are in stash "autostash before checkout feature/x": they conflict with feature/x.');
    expect(screen.queryByRole('button', { name: 'Drop stash' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(selectCommit).toHaveBeenCalledWith('t', 'abc1234def');
    api.applyKeptStash.mockResolvedValueOnce(wr());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply' })); });
    expect(api.applyKeptStash).toHaveBeenCalledWith(4, '/r', 5, false, false);
  });

  it('Apply asks before dropping what was staged, then applies without the index', async () => {
    show([{ ...base, kind: 'autostashRefused' }]);
    api.applyKeptStash.mockRejectedValueOnce({ kind: 'Conflict', message: 'x', commandId: null, stderr: null, detail: { kind: 'applyWithoutIndex' } }).mockResolvedValueOnce(wr());
    confirm.answer = true;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply' })); });
    expect(api.applyKeptStash.mock.calls.map((c) => c[3])).toEqual([false, true]);
  });

  it('a Restore over paths changed since asks the clean-restore question, then confirms it', async () => {
    show([{ ...base, kind: 'recovery', label: 'discard a.php', stash: null, stashMessage: null, target: null, snapshot: true }]);
    api.applyKeptStash.mockRejectedValueOnce({ kind: 'Conflict', message: 'x', commandId: null, stderr: null, detail: { kind: 'autostashConflict', paths: ['a.php'], target: 'discard a.php' } }).mockResolvedValueOnce(wr());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore' })); });
    expect(confirm.asked[0].body).toBe('Your changes to a.php conflict with discard a.php. They\'ll be kept in a stash you can apply afterwards.');
    expect(api.applyKeptStash.mock.calls.map((c) => c[4])).toEqual([false, true]);
  });

  it('a restore with conflicts: Show, Drop stash, ×', async () => {
    show([{ ...base, kind: 'autostashConflicts', files: 2, canDrop: true }]);
    expect(notices()).toHaveTextContent('Your restored changes conflict in 2 files; resolve them in Conflicted. The stash is kept until you drop it.');
    api.dismissBanner.mockResolvedValue(state([]));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Drop stash' })); });
    expect(confirm.asked).toEqual([]);
    expect(api.dismissBanner).toHaveBeenCalledWith(4, '/r', 5, true);
  });

  it('a binary conflict warns before Drop that only the current version is kept', async () => {
    show([{ ...base, kind: 'autostashConflicts', files: 1, canDrop: true, binary: true }]);
    api.dismissBanner.mockResolvedValue(state([]));
    confirm.answer = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Drop stash' })); });
    expect(confirm.asked[0].body).toContain('only the current version');
    expect(api.dismissBanner).not.toHaveBeenCalled();
    confirm.answer = true;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Drop stash' })); });
    expect(api.dismissBanner).toHaveBeenCalledWith(4, '/r', 5, true);
  });

  it('a partial restore and a stopped stash: Apply and Show, never Drop', () => {
    show([{ ...base, kind: 'autostashPartial' }, { ...base, entry: 6, kind: 'autostashStopped' }]);
    const text = notices().textContent;
    expect(text).toContain('Your changes from before checkout feature/x were partly restored; the stash still has everything.');
    expect(text).toContain('Checkout feature/x didn\'t run: saving your changes was stopped. They\'re in stash "autostash before checkout feature/x".');
    expect(screen.getAllByRole('button', { name: 'Apply' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Show' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Drop stash' })).toBeNull();
  });

  it('an interrupted abort says it may not have run, and where the work is (3C final fix M6)', () => {
    show([{ ...base, kind: 'abortInterrupted', label: 'abort the rebase of feature/x', stashMessage: 'GitBolt: work from the aborted rebase of feature/x', target: 'feature/x-rebase-work' }]);
    expect(notices().textContent).toContain('GitBolt stopped before it could abort the rebase of feature/x: the abort may not have run; your work is in the working tree or the stash "GitBolt: work from the aborted rebase of feature/x", and your commits from the stop are on feature/x-rebase-work.');
  });

  it('× dismisses and keeps the stash', async () => {
    show([{ ...base, kind: 'autostashConflicts', files: 1, canDrop: true }]);
    api.dismissBanner.mockResolvedValue(state([]));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(api.dismissBanner).toHaveBeenCalledWith(4, '/r', 5, false);
    expect(screen.queryByRole('region', { name: 'Notices' })).toBeNull();
  });

  it('a failed Drop goes to the error toast, with Remove stale lock', async () => {
    show([{ ...base, kind: 'autostashConflicts', files: 1, canDrop: true }]);
    api.dismissBanner.mockRejectedValueOnce({ kind: 'IndexLocked', message: 'locked', commandId: null, stderr: null });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Drop stash' })); });
    expect(typeof toast.calls[0].ctx.removeLock).toBe('function');
  });

  it('× on a recovery snapshot asks first: it is the only copy', async () => {
    show([{ ...base, kind: 'recovery', label: 'discard a.php', stash: null, stashMessage: null, target: null, snapshot: true }]);
    api.dismissBanner.mockResolvedValue(state([]));
    confirm.answer = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(confirm.asked[0].body).toBe('The snapshot is the only copy of your changes from before discard a.php. Once dismissed, GitBolt can\'t restore them.');
    expect(api.dismissBanner).not.toHaveBeenCalled();
    confirm.answer = true;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(api.dismissBanner).toHaveBeenCalledWith(4, '/r', 5, false);
  });

  it('crash recovery: Restore for a snapshot, Apply for an autostash', () => {
    show([{ ...base, kind: 'recovery', label: 'discard a.php', stash: null, stashMessage: null, target: null, snapshot: true }, { ...base, entry: 6, kind: 'recovery', label: 'checkout feature/x' }]);
    const text = notices().textContent;
    expect(text).toContain('GitBolt stopped during discard a.php. Your changes are safe in a snapshot.');
    expect(text).toContain('GitBolt stopped during checkout feature/x. Your changes are safe in the autostash.');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Apply' })).toHaveLength(1);
  });
});
