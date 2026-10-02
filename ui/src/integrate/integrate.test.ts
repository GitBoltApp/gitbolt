import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { integrateRows, startIntegrate } from './integrate';

const ask = vi.fn();
vi.mock('../ui/ChoiceDialog', () => ({ askChoice: (...a: unknown[]) => ask(...a) }));

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const ok = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null });
const preview = (p: Partial<{ conflicts: string[]; stacked: Array<{ name: string; worktree: string | null }>; merged: boolean; lossyMerge: string | null }>) => ({ ahead: 1, behind: 1, merged: false, conflicts: [], stacked: [], updateRefsDefault: true, updateRefsSupported: true, lossyMerge: null, ...p });

describe('integrate (spec #2 §13.1)', () => {
  beforeEach(() => { vi.restoreAllMocks(); ask.mockReset(); });

  it('offers ff, merge and rebase on another branch, greyed during a rebase', () => {
    const t = { sha: 'a', mrRefs: [], isWip: false, isStash: false, branch: { name: 'feature/x', local: 'refs/heads/feature/x', remotes: [] } };
    const env = { headBranch: 'main' } as never;
    const labels = integrateRows(t, env, null).map((r) => (r.kind === 'action' ? r.label : ''));
    expect(labels).toEqual(['Fast-forward feature/x to main', 'Merge feature/x into main', 'Rebase main onto feature/x']);
    expect(integrateRows(t, env, 'Finish or abort the rebase first').every((r) => r.kind === 'action' && r.disabledReason === 'Finish or abort the rebase first')).toBe(true);
    expect(integrateRows({ ...t, branch: { name: 'main', local: 'refs/heads/main', remotes: [] } }, env, null)).toEqual([]);
  });

  it('a rebase with a stack asks with the checkbox and sends its answer explicitly', async () => {
    vi.spyOn(api, 'integratePreview').mockResolvedValue(preview({ stacked: [{ name: 'feature/a', worktree: null }, { name: 'feature/b', worktree: null }] }));
    const send = vi.spyOn(api, 'integrate').mockResolvedValue(ok({ status: 'done', commits: 3, fastForward: false }) as never);
    ask.mockResolvedValue({ choice: 'go', checked: false });
    await startIntegrate(ctx, 'rebase', 'main', 'feature/c');
    expect(ask.mock.calls[0][0].checkbox).toEqual({ label: 'Also move 2 stacked branches', checked: true, detail: 'feature/a, feature/b' });
    expect(send).toHaveBeenCalledWith(1, '/r', 'rebase', 'main', { updateRefs: false, confirmAutostash: false });
  });

  it('a merge without conflicts runs at once; with conflicts it confirms first', async () => {
    vi.spyOn(api, 'integratePreview').mockResolvedValueOnce(preview({})).mockResolvedValueOnce(preview({ conflicts: ['a.txt', 'b.txt'] }));
    vi.spyOn(api, 'integrate').mockResolvedValue(ok({ status: 'done', commits: 2, fastForward: false }) as never);
    await startIntegrate(ctx, 'merge', 'clean', 'main');
    expect(ask).not.toHaveBeenCalled();
    ask.mockResolvedValue({ choice: null, checked: false });
    await startIntegrate(ctx, 'merge', 'feature/x', 'main');
    expect(ask.mock.calls[0][0].body).toBe('Merging feature/x into main will conflict in 2 files.');
    expect(api.integrate).toHaveBeenCalledTimes(1);
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
