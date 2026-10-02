import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { MenuEnv } from '../menu/menuEnv';
import * as confirm from '../ui/ConfirmDialog';
import { deleteBranch, deleteRow } from './delete';

const local = (name: string, over: object = {}) => ({ name, fullName: `refs/heads/${name}`, target: 'aaa', upstream: `refs/remotes/origin/${name}`, gone: false, checkedOut: null, ...over });
const env = (locals: object[], remotes: Array<{ name: string; target: string }> = [{ name: 'feature/x', target: 'bbb' }]) => ({
  activeWorktree: '/r', write: { tabId: 't', repoId: 1, worktree: '/r' },
  sidebar: { locals, remotes: [{ name: 'origin', branches: remotes.map((b) => ({ ...b, fullName: `refs/remotes/origin/${b.name}` })) }], worktrees: [], stashes: [], tags: [] },
  worktreeShown: (p: string) => p.replace('/r-', '../r-'),
}) as unknown as MenuEnv;
const target = (name: string, isLocal = true) => ({ sha: 'aaa', mrRefs: [], isWip: false, isStash: false, branch: { name, local: isLocal ? `refs/heads/${name}` : null, remotes: [] } });
const variants = (row: ReturnType<typeof deleteRow>) => (row?.kind === 'action' ? Object.fromEntries((row.variants ?? []).map((v) => [v.id, v.disabledReason ?? null])) : {});

describe('Delete | Local | Remote | Both | (spec #2 §9.2)', () => {
  it('offers all three for a local branch with an upstream', () => {
    const row = deleteRow(target('feature/x'), env([local('feature/x')]));
    expect(row?.kind === 'action' && row.disabledReason).toBeFalsy();
    expect(variants(row)).toEqual({ local: null, remote: null, both: null });
  });
  it('greys out what doesn\'t apply, with the reason', () => {
    expect(variants(deleteRow(target('solo'), env([local('solo', { upstream: null })], [])))).toEqual({ local: null, remote: 'No remote branch', both: 'No remote branch' });
    expect(variants(deleteRow(target('feature/x', false), env([])))).toEqual({ local: 'No local branch', remote: null, both: 'No local branch' });
    const here = deleteRow(target('feature/x'), env([local('feature/x', { checkedOut: '/r' })]));
    expect(variants(here).local).toBe('Checked out');
    expect(here?.kind === 'action' && here.disabledReason).toBe('Checked out');
    expect(variants(deleteRow(target('feature/x'), env([local('feature/x', { checkedOut: '/r-x' })]))).local).toBe('Checked out in ../r-x');
  });
  it('the label deletes the remote branch when there is only a remote one', () => {
    const row = deleteRow(target('feature/x', false), env([]));
    expect(row?.kind === 'action' && [row.disabledReason, row.tooltip]).toEqual([undefined, 'Delete origin/feature/x from origin']);
  });
});

describe('the confirmations', () => {
  const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
  const ok = { outcome: { status: 'deleted' }, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null };
  const remote = { remote: 'origin', branch: 'feature/x', lease: 'bbb' };
  afterEach(() => vi.restoreAllMocks());

  it('Both asks once, names the unpushed commits, and sends force', async () => {
    const ask = vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true);
    const del = vi.spyOn(api, 'deleteBranch').mockResolvedValue(ok as never);
    await deleteBranch(ctx, { branch: 'feature/x', local: { oid: 'aaa' }, remote, unpushed: 2 });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0].body).toContain('has 2 commits that aren\'t on it');
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(1, '/r', expect.objectContaining({ local: true, remote, force: true }));
  });
  it('declining Both sends nothing', async () => {
    vi.spyOn(confirm, 'confirmAction').mockResolvedValue(false);
    const del = vi.spyOn(api, 'deleteBranch').mockResolvedValue(ok as never);
    await deleteBranch(ctx, { branch: 'feature/x', local: { oid: 'aaa' }, remote });
    expect(del).not.toHaveBeenCalled();
  });
  it('Local with unmerged commits asks, then sends again with force', async () => {
    const ask = vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true);
    const del = vi.spyOn(api, 'deleteBranch')
      .mockResolvedValueOnce({ ...ok, outcome: { status: 'unmerged', branch: 'feature/x', into: 'main', commits: 1 } } as never)
      .mockResolvedValueOnce(ok as never);
    await deleteBranch(ctx, { branch: 'feature/x', local: { oid: 'aaa' }, remote: null });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(del.mock.calls.map((c) => c[2].force)).toEqual([false, true]);
  });
});
