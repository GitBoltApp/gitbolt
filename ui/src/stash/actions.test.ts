import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.hoisted(() => ({ answer: true }));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: vi.fn(async () => confirm.answer) }));
vi.mock('../debug/errorToast', () => ({ toastActionError: () => {} }));
import { api } from '../api/client';
import { useRuntime } from '../app/runtime';
import { readWipDraft, writeWipDraft } from '../commit/draft';
import { useToast } from '../ui/toastStore';
import { applyStash, dropStash, stashPushFor } from './actions';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const res = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null });

describe('stashes (spec #2 §10, §8.2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useRuntime.setState({ tabs: { t: { ...useRuntime.getState().tabs.t, repo: { id: 1, path: '/r' } } } } as never);
    writeWipDraft('/r', '/r', { summary: '', description: '' });
    useToast.getState().dismiss();
  });
  it('a full stash uses the WIP draft as its message, then clears it', async () => {
    writeWipDraft('/r', '/r', { summary: 'Fix x', description: 'the details' });
    const push = vi.spyOn(api, 'stashPush').mockResolvedValue(res({ status: 'stashed', oid: 'abc' }) as never);
    await stashPushFor(ctx);
    expect(push).toHaveBeenCalledWith(1, '/r', 'Fix x\n\nthe details');
    expect(readWipDraft('/r', '/r')).toEqual({ summary: '', description: '' });
  });
  it('nothing to stash keeps the draft and says so', async () => {
    writeWipDraft('/r', '/r', { summary: 'Keep me', description: '' });
    vi.spyOn(api, 'stashPush').mockResolvedValue(res({ status: 'nothingToStash' }) as never);
    await stashPushFor(ctx);
    expect(readWipDraft('/r', '/r').summary).toBe('Keep me');
    expect(useToast.getState().message).toBe('No changes to stash');
  });
  it('an empty draft sends an empty message (the backend names the branch)', async () => {
    const push = vi.spyOn(api, 'stashPush').mockResolvedValue(res({ status: 'stashed', oid: 'abc' }) as never);
    await stashPushFor(ctx);
    expect(push).toHaveBeenCalledWith(1, '/r', '');
  });
  it('apply, pop and drop send the oid; conflicts say where they went', async () => {
    const apply = vi.spyOn(api, 'stashApply').mockResolvedValue(res({ status: 'conflicts', files: 2 }) as never);
    await applyStash(ctx, 'oid1', true);
    expect(apply).toHaveBeenCalledWith(1, '/r', 'oid1', true, false);
    expect(useToast.getState().message).toBe('The stash conflicts in 2 files; resolve them in Conflicted. The stash is kept.');
    const drop = vi.spyOn(api, 'stashDrop').mockResolvedValue(res(null) as never);
    await dropStash(ctx, 'oid2');
    expect(drop).toHaveBeenCalledWith(1, '/r', 'oid2');
  });
  it('a refused --index asks, then resends with withoutIndex', async () => {
    confirm.answer = true;
    const refused = { kind: 'Conflict', message: 'x', commandId: null, stderr: null, detail: { kind: 'applyWithoutIndex' } };
    const apply = vi.spyOn(api, 'stashApply').mockRejectedValueOnce(refused).mockResolvedValueOnce(res({ status: 'applied' }) as never);
    await applyStash(ctx, 'oid1', false);
    expect(apply).toHaveBeenNthCalledWith(1, 1, '/r', 'oid1', false, false);
    expect(apply).toHaveBeenNthCalledWith(2, 1, '/r', 'oid1', false, true);
  });
  it('a failed push keeps the draft', async () => {
    writeWipDraft('/r', '/r', { summary: 'Keep me', description: '' });
    vi.spyOn(api, 'stashPush').mockRejectedValue({ kind: 'Git', message: 'boom', commandId: null, stderr: null, detail: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await stashPushFor(ctx);
    expect(readWipDraft('/r', '/r').summary).toBe('Keep me');
  });
});
