import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { LocalBranch } from '../api/gen/LocalBranch';
import { useToast } from '../ui/toast';
import { pull, pullRow, syncView } from './pull';

const ask = vi.fn();
vi.mock('../ui/ChoiceDialog', () => ({ askChoice: (...a: unknown[]) => ask(...a) }));
vi.mock('./push', () => ({ headBranchOf: () => 'main' }));

const main: LocalBranch = { name: 'main', fullName: 'refs/heads/main', target: 'a'.repeat(40), upstream: 'refs/remotes/origin/main', ahead: 0, behind: 1, gone: false, tipTime: 0, summary: '', author: '', isHead: true, worktree: null, checkedOut: null, pushTarget: 'origin/main', pushBehind: 1, rewritten: null };
const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const journal = { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null };
const result = (result: unknown) => ({ outcome: { op: 3, branch: 'main', upstream: 'origin/main', server: { lines: 0, warning: null }, result }, journal, staging: { undo: null, redo: null, off: null }, wip: null });

describe('the Fetch/Pull button (spec #2 §12.1)', () => {
  it('its caption and tooltip follow the default', () => {
    expect(syncView('fetchAll', main, 'main')).toEqual({ label: 'Fetch', tooltip: 'Fetch every remote', disabled: false });
    expect(syncView('pullFfOnly', main, 'main')).toEqual({ label: 'Pull', tooltip: 'Pull origin/main into main (fast-forward only)', disabled: false });
    expect(syncView('pullFfOrMerge', main, 'main').tooltip).toBe('Pull origin/main into main (fast-forward if possible)');
    expect(syncView('pullRebase', main, 'main').tooltip).toBe('Pull origin/main into main (rebase)');
    expect(syncView('pullFfOnly', { ...main, upstream: null }, 'main')).toEqual({ label: 'Pull', tooltip: 'main has no upstream; set one from Push ▾', disabled: true });
    expect(syncView('pullFfOnly', undefined, null).disabled).toBe(true);
  });
});

describe('pull (spec #2 §12.2)', () => {
  beforeEach(() => { vi.restoreAllMocks(); ask.mockReset(); useToast.getState().dismiss(); });

  it('says what it did', async () => {
    vi.spyOn(api, 'pull').mockResolvedValue(result({ status: 'fastForward', commits: 3 }) as never);
    await pull(ctx, 'ffOnly');
    expect(useToast.getState().message).toBe('Pulled 3 commits into main (fast-forward)');
    vi.spyOn(api, 'pull').mockResolvedValue(result({ status: 'upToDate', ahead: 2 }) as never);
    await pull(ctx, 'ffOnly');
    expect(useToast.getState().message).toBe('main is up to date (2 ahead: push)');
  });

  it('diverged asks Rebase / Merge / Cancel, then integrates locally without fetching again', async () => {
    vi.spyOn(api, 'pull').mockResolvedValue(result({ status: 'diverged', ahead: 2, behind: 3, conflicts: 1 }) as never);
    const integrate = vi.spyOn(api, 'integrate').mockResolvedValue({ outcome: { status: 'done', commits: 2, fastForward: false }, journal, staging: { undo: null, redo: null, off: null }, wip: null } as never);
    ask.mockResolvedValue({ choice: 'rebase', checked: false });
    await pull(ctx, 'ffOnly');
    expect(ask.mock.calls[0][0]).toMatchObject({ title: 'Pull main?', body: 'main and origin/main have diverged (2 ahead, 3 behind).', note: 'Merging would conflict in 1 file.' });
    expect(ask.mock.calls[0][0].choices.map((c: { label: string }) => c.label)).toEqual(['Rebase', 'Merge']);
    expect(integrate).toHaveBeenCalledWith(1, '/r', 'rebase', 'origin/main', { confirmAutostash: false });
    // The toast counts the commits pulled in (behind), not the 2 integrate replayed.
    expect(useToast.getState().message).toBe('Pulled 3 commits into main (rebase)');
    expect(api.pull).toHaveBeenCalledTimes(1);
  });

  it('diverged on a branch that is not checked out only says to check it out', async () => {
    vi.spyOn(api, 'pull').mockResolvedValue({ ...result({ status: 'diverged', ahead: 1, behind: 1, conflicts: 0 }), outcome: { op: 3, branch: 'dev', upstream: 'origin/dev', server: { lines: 0, warning: null }, result: { status: 'diverged', ahead: 1, behind: 1, conflicts: 0 } } } as never);
    await pull(ctx, 'ffOnly', 'dev');
    expect(ask).not.toHaveBeenCalled();
    expect(useToast.getState().message).toBe('dev and origin/dev have diverged; check out dev first');
  });

  it('the Sync row: only ff-only on a branch that isn\'t checked out; no row without an upstream', () => {
    const row = pullRow({ ...main, isHead: false, name: 'dev' }, () => {});
    expect(row?.kind === 'action' && row.variants?.map((v) => v.id)).toEqual(['ffOnly']);
    const head = pullRow(main, () => {});
    expect(head?.kind === 'action' && head.variants?.map((v) => v.id)).toEqual(['ffOnly', 'rebase', 'merge']);
    expect(pullRow({ ...main, upstream: null }, () => {})).toBeNull();
    expect(pullRow({ ...main, gone: true }, () => {})).toBeNull();
  });
});
