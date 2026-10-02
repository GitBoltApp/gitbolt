import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { buildMenu } from '../menu/registry';
import { confirmAction } from '../ui/ConfirmDialog';
import { markResolved, resolveFile } from './resolve';
import './menus';
import { useToast } from '../ui/toast';

vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: vi.fn(async () => true) }));

const ctx = { tabId: 't', repoId: 3, worktree: '/r' };
const ok = { outcome: null, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null };
const discardEdits = { kind: 'Conflict', message: 'Discard your edits to a.txt?', commandId: null, stderr: null, detail: { kind: 'discardEdits', path: 'a.txt' } };
const markersRemain = { kind: 'Conflict', message: 'a.txt still has conflict markers', commandId: null, stderr: null, detail: { kind: 'markersRemain', path: 'a.txt' } };

describe('resolving conflicted files (spec #2 §13.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(confirmAction).mockClear();
  });

  it('Mark resolved asks when markers remain, then sends it confirmed', async () => {
    const send = vi.spyOn(api, 'resolveFile')
      .mockRejectedValueOnce(markersRemain)
      .mockResolvedValueOnce(ok as never);
    expect(await markResolved(ctx, 'a.txt')).toBe(true);
    expect(send).toHaveBeenNthCalledWith(1, 3, '/r', 'a.txt', { kind: 'asIs' }, undefined, false, false);
    expect(send).toHaveBeenNthCalledWith(2, 3, '/r', 'a.txt', { kind: 'asIs' }, undefined, true, false);
    expect(vi.mocked(confirmAction).mock.calls[0][0]).toMatchObject({ title: 'Conflict markers remain', confirmLabel: 'Mark resolved' });
  });

  it('a "no" to the question sends nothing more', async () => {
    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    const send = vi.spyOn(api, 'resolveFile').mockRejectedValueOnce(markersRemain);
    expect(await markResolved(ctx, 'a.txt')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a text resolution carries the conflictFile base', async () => {
    const send = vi.spyOn(api, 'resolveFile').mockResolvedValueOnce(ok as never);
    expect(await resolveFile(ctx, 'a.txt', { kind: 'text', text: 'x\n' }, 'h1')).toBe(true);
    expect(send).toHaveBeenCalledWith(3, '/r', 'a.txt', { kind: 'text', text: 'x\n' }, 'h1', false, false);
  });

  it('Take current over hand edits asks "Discard your edits?", then sends confirmDiscard', async () => {
    const send = vi.spyOn(api, 'resolveFile')
      .mockRejectedValueOnce(discardEdits)
      .mockResolvedValueOnce(ok as never);
    expect(await resolveFile(ctx, 'a.txt', { kind: 'current' })).toBe(true);
    expect(send).toHaveBeenNthCalledWith(1, 3, '/r', 'a.txt', { kind: 'current' }, undefined, false, false);
    expect(send).toHaveBeenNthCalledWith(2, 3, '/r', 'a.txt', { kind: 'current' }, undefined, false, true);
    expect(vi.mocked(confirmAction).mock.calls[0][0]).toMatchObject({ title: 'Discard your edits?', danger: true });
  });

  it('a submodule side taken while the submodule is checked out elsewhere warns', async () => {
    const show = vi.spyOn(useToast.getState(), 'show');
    vi.spyOn(api, 'resolveFile').mockResolvedValueOnce({ ...ok, outcome: { path: 'sub', head: 'a'.repeat(40), taken: 'b'.repeat(40) } } as never);
    expect(await resolveFile(ctx, 'sub', { kind: 'incoming' })).toBe(true);
    expect(show).toHaveBeenCalledWith('Submodule sub is still checked out at aaaaaa: update it to bbbbbb before committing', expect.anything());
  });

  it('a menu row clicked with no repository tab says so', () => {
    const show = vi.spyOn(useToast.getState(), 'show');
    const target = { path: 'a.txt', root: '/r', sha: null, upstream: null, diff: { key: 'k', path: 'a.txt', oldPath: null, status: 'U', old: { kind: 'absent' }, new: { kind: 'worktree' }, view: 'diff' }, changed: true, deleted: false, list: 'wip', openIn: {} };
    const rows = buildMenu('file', target as never, {} as never);
    const take = rows.find((r) => r.kind === 'action' && r.id === 'file.takeCurrent') as { run: () => void };
    take.run();
    expect(show).toHaveBeenCalledWith(expect.stringContaining("Couldn't resolve a.txt"), expect.anything());
  });

  it('a conflicted WIP file gets Take current, Take incoming and Mark resolved; others don\'t', () => {
    const target = (status: string, list = 'wip') => ({ path: 'a.txt', root: '/r', sha: null, upstream: null, diff: { key: 'k', path: 'a.txt', oldPath: null, status, old: { kind: 'absent' }, new: { kind: 'worktree' }, view: 'diff' }, changed: true, deleted: false, list, openIn: {} });
    const ids = (status: string, list?: string) => buildMenu('file', target(status, list) as never, {} as never).filter((r) => r.kind === 'action').map((r) => (r as { id: string }).id);
    expect(ids('U')).toEqual(expect.arrayContaining(['file.takeCurrent', 'file.takeIncoming', 'file.markResolved']));
    expect(ids('M')).not.toContain('file.markResolved');
    expect(ids('U', 'commit')).not.toContain('file.markResolved');
  });
});
