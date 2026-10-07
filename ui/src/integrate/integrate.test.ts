import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { integrateRows, startIntegrate } from './integrate';

const ask = vi.fn();
vi.mock('../ui/ChoiceDialog', () => ({ askChoice: (...a: unknown[]) => ask(...a) }));
const confirm = vi.fn();
vi.mock('../ui/ConfirmDialog', () => ({ confirmWith: (...a: unknown[]) => confirm(...a) }));

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const ok = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null });
const preview = (p: Partial<{ ahead: number; conflicts: string[]; stacked: Array<{ name: string; worktree: string | null }>; merged: boolean; lossyMerge: string | null }>) => ({ ahead: 1, behind: 1, merged: false, conflicts: [], stacked: [], updateRefsDefault: true, lossyMerge: null, ...p });

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

  it('labels the merge a fast-forward when HEAD is in the target\'s history, and then passes ff-only', async () => {
    const t = { sha: 'a', mrRefs: [], isWip: false, isStash: false, branch: { name: 'feature/x', local: 'refs/heads/feature/x', remotes: [] } };
    const merge = (isAncestor: (a: string, b: string) => boolean | null) => {
      const go = vi.fn();
      const row = integrateRows(t, { headBranch: 'main', headSha: 'h', isAncestor } as never, null, { ff: () => {}, go }).find((r) => r.kind === 'action' && r.id === 'integrate.merge');
      return { row: row as Extract<typeof row, { kind: 'action' }>, go };
    };
    const ffable = merge((a, b) => a === 'h' && b === 'a');
    expect(ffable.row.label).toBe('Fast-forward main to feature/x');
    expect(ffable.row.tooltip).toMatch(/no merge commit/);
    ffable.row.run();
    expect(ffable.go).toHaveBeenCalledWith('merge', 'feature/x', true);
    const diverged = merge(() => false);
    expect(diverged.row.label).toBe('Merge feature/x into main');
    diverged.row.run();
    expect(diverged.go).toHaveBeenCalledWith('merge', 'feature/x');
    expect(merge(() => null).row.label).toBe('Merge feature/x into main');
    vi.spyOn(api, 'integratePreview').mockResolvedValue(preview({}));
    const send = vi.spyOn(api, 'integrate').mockResolvedValue(ok({ status: 'done', commits: 1, fastForward: true }) as never);
    await startIntegrate(ctx, 'merge', 'feature/x', 'main', true);
    expect(send.mock.calls[0][4]).toMatchObject({ ffOnly: true });
  });

  it('a rebase with a stack arms the row with the checkbox under it, and sends its answer explicitly (UX round 3)', async () => {
    vi.spyOn(api, 'integratePreview').mockResolvedValue(preview({ stacked: [{ name: 'feature/a', worktree: null }, { name: 'feature/b', worktree: '/r-b' }] }));
    const send = vi.spyOn(api, 'integrate').mockResolvedValue(ok({ status: 'done', commits: 3, fastForward: false }) as never);
    confirm.mockResolvedValue({ ok: true, checked: false });
    await startIntegrate(ctx, 'rebase', 'main', 'feature/c');
    expect(ask).not.toHaveBeenCalled();
    const req = confirm.mock.calls[0][0];
    expect(req).toMatchObject({ arm: 'Click again to rebase feature/c onto main', tone: 'positive', body: undefined });
    expect(req.option).toEqual({ label: 'Also move 2 stacked branches', checked: true, detail: 'feature/a, feature/b', note: 'feature/b is checked out in /r-b: git leaves it where it is.' });
    expect(send).toHaveBeenCalledWith(1, '/r', 'rebase', 'main', { updateRefs: false, confirmAutostash: false });
    // Not confirmed: nothing runs.
    confirm.mockResolvedValue({ ok: false, checked: false });
    await startIntegrate(ctx, 'rebase', 'main', 'feature/c');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a rebase that stops without a conflict says why (UX F: the signer failed)', async () => {
    vi.spyOn(api, 'integratePreview').mockResolvedValue(preview({}));
    const why = 'The rebase stopped: gpg failed to sign the data: gpg: signing failed: No pinentry';
    vi.spyOn(api, 'integrate').mockResolvedValue(ok({ status: 'stopped', kind: 'rebase', files: 0, warning: why }) as never);
    const { useToast } = await import('../ui/toastStore');
    useToast.getState().dismiss();
    await startIntegrate(ctx, 'rebase', 'main', 'feature/c');
    expect(useToast.getState()).toMatchObject({ message: why, tone: 'warning' });
  });

  it('a merge without conflicts runs at once; with conflicts the clicked row arms first (board A)', async () => {
    vi.spyOn(api, 'integratePreview').mockResolvedValueOnce(preview({})).mockResolvedValueOnce(preview({ conflicts: ['a.txt', 'b.txt'] })).mockResolvedValueOnce(preview({ ahead: 2, conflicts: ['a.txt'] }));
    vi.spyOn(api, 'integrate').mockResolvedValue(ok({ status: 'done', commits: 2, fastForward: false }) as never);
    await startIntegrate(ctx, 'merge', 'clean', 'main');
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockResolvedValue({ ok: false, checked: false });
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
    ask.mockResolvedValue({ choice: 'go' });
    await startIntegrate(ctx, 'rebase', 'main', 'feature');
    const req = ask.mock.calls[0][0];
    expect(req.body).toBe('A merge has changes of its own. Merge main into feature instead.');
    expect(req.choices).toEqual([expect.objectContaining({ id: 'go', disabled: true })]);
    expect(send).not.toHaveBeenCalled();
  });
});
