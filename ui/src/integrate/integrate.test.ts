import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { integrateRows, startIntegrate } from './integrate';

const ask = vi.fn();
vi.mock('../ui/ChoiceDialog', () => ({ askChoice: (...a: unknown[]) => ask(...a) }));
const confirm = vi.fn();
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: (...a: unknown[]) => confirm(...a) }));

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const ok = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null });
const preview = (p: Partial<{ ahead: number; conflicts: string[]; stacked: Array<{ name: string; worktree: string | null }>; merged: boolean; lossyMerge: string | null }>) => ({ ahead: 1, behind: 1, merged: false, conflicts: [], stacked: [], updateRefsDefault: true, updateRefsSupported: true, lossyMerge: null, ...p });

describe('integrate (spec #2 §13.1)', () => {
  beforeEach(() => { vi.restoreAllMocks(); ask.mockReset(); confirm.mockReset(); });

  it('offers ff, merge and rebase on another branch, greyed during a rebase', () => {
    const t = { sha: 'a', mrRefs: [], isWip: false, isStash: false, branch: { name: 'feature/x', local: 'refs/heads/feature/x', remotes: [] } };
    const env = { headBranch: 'main' } as never;
    const labels = integrateRows(t, env, null).map((r) => (r.kind === 'action' ? r.label : ''));
    expect(labels).toEqual(['Fast-forward feature/x to main', 'Merge feature/x into main', 'Rebase main onto feature/x']);
    expect(integrateRows(t, env, 'Finish or abort the rebase first').every((r) => r.kind === 'action' && r.disabledReason === 'Finish or abort the rebase first')).toBe(true);
    expect(integrateRows({ ...t, branch: { name: 'main', local: 'refs/heads/main', remotes: [] } }, env, null)).toEqual([]);
  });

  it('shows only what can apply, from the loaded ancestry', () => {
    const t = { sha: 'a', mrRefs: [], isWip: false, isStash: false, branch: { name: 'feature/x', local: 'refs/heads/feature/x', remotes: [] } };
    const ids = (env: object) => integrateRows(t, { headBranch: 'main', headSha: 'h', ...env } as never, null).map((r) => (r.kind === 'action' ? r.id : ''));
    // feature/x is behind main: only the fast-forward (merging or rebasing is a no-op).
    expect(ids({ isAncestor: () => true })).toEqual(['integrate.ff']);
    // Not behind main (ahead or diverged): no fast-forward.
    expect(ids({ isAncestor: () => false })).toEqual(['integrate.merge', 'integrate.rebase']);
    // Unknown (not loaded): all three, checked after the click.
    expect(ids({ isAncestor: () => null })).toEqual(['integrate.ff', 'integrate.merge', 'integrate.rebase']);
    // Behind but checked out in a worktree: it can't be fast-forwarded in place.
    const sidebar = { locals: [{ fullName: 'refs/heads/feature/x', checkedOut: '/r-x' }] };
    expect(ids({ isAncestor: () => true, sidebar })).toEqual([]);
    // A remote-only branch never gets the fast-forward.
    const remote = { ...t, branch: { name: 'origin/y', local: null, remotes: [{ fullName: 'refs/remotes/origin/y', remote: 'origin' }] } };
    expect(integrateRows(remote, { headBranch: 'main', headSha: 'h', isAncestor: () => false } as never, null).map((r) => (r.kind === 'action' ? r.label : ''))).toEqual(['Merge origin/y into main', 'Rebase main onto origin/y']);
  });

  it('a rebase with a stack asks with the checkbox and sends its answer explicitly', async () => {
    vi.spyOn(api, 'integratePreview').mockResolvedValue(preview({ stacked: [{ name: 'feature/a', worktree: null }, { name: 'feature/b', worktree: null }] }));
    const send = vi.spyOn(api, 'integrate').mockResolvedValue(ok({ status: 'done', commits: 3, fastForward: false }) as never);
    ask.mockResolvedValue({ choice: 'go', checked: false });
    await startIntegrate(ctx, 'rebase', 'main', 'feature/c');
    expect(ask.mock.calls[0][0].checkbox).toEqual({ label: 'Also move 2 stacked branches', checked: true, detail: 'feature/a, feature/b' });
    expect(send).toHaveBeenCalledWith(1, '/r', 'rebase', 'main', { updateRefs: false, confirmAutostash: false });
  });

  it('a merge without conflicts runs at once; with conflicts the clicked row arms first (board A)', async () => {
    vi.spyOn(api, 'integratePreview').mockResolvedValueOnce(preview({})).mockResolvedValueOnce(preview({ conflicts: ['a.txt', 'b.txt'] })).mockResolvedValueOnce(preview({ ahead: 2, conflicts: ['a.txt'] }));
    vi.spyOn(api, 'integrate').mockResolvedValue(ok({ status: 'done', commits: 2, fastForward: false }) as never);
    await startIntegrate(ctx, 'merge', 'clean', 'main');
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockResolvedValue(false);
    await startIntegrate(ctx, 'merge', 'feature/x', 'main');
    expect(confirm.mock.calls[0][0]).toMatchObject({ body: 'Merging feature/x into main will conflict in 2 files.', arm: 'Click again to merge feature/x (conflicts in 2 files)' });
    expect(api.integrate).toHaveBeenCalledTimes(1);
    await startIntegrate(ctx, 'rebase', 'main', 'feature/x');
    expect(confirm.mock.calls[1][0].arm).toBe('Click again to rebase onto main (2 commits, conflicts in 1 file)');
    expect(ask).not.toHaveBeenCalled();
  });

  it('a refused rebase (lossyMerge) shows the reason with Rebase disabled, and never sends', async () => {
    vi.spyOn(api, 'integratePreview').mockResolvedValue(preview({ lossyMerge: 'A merge has changes of its own. Merge main into feature instead.' }));
    const send = vi.spyOn(api, 'integrate').mockResolvedValue(ok({ status: 'done', commits: 1, fastForward: false }) as never);
    ask.mockResolvedValue({ choice: 'go', checked: false });
    await startIntegrate(ctx, 'rebase', 'main', 'feature');
    const req = ask.mock.calls[0][0];
    expect(req.body).toBe('A merge has changes of its own. Merge main into feature instead.');
    expect(req.choices).toEqual([expect.objectContaining({ id: 'go', disabled: true })]);
    expect(send).not.toHaveBeenCalled();
  });
});
