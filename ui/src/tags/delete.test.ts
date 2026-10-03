import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import * as confirm from '../ui/ConfirmDialog';
import { deleteTag } from './delete';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const ok = { outcome: null, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null } as never;

afterEach(() => vi.restoreAllMocks());

describe('Delete | Local | Remote | Both | on a tag (spec #3 §3.9)', () => {
  it('local goes at once (it can be undone)', async () => {
    const ask = vi.spyOn(confirm, 'confirmAction');
    const del = vi.spyOn(api, 'deleteTag').mockResolvedValue(ok);
    await deleteTag(ctx, { tag: 'v1', local: true, remote: null }, null);
    expect(ask).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(1, '/r', { name: 'v1', local: true, remote: null });
  });
  it("remote arms in place first: it can't be undone; No sends nothing", async () => {
    const ask = vi.spyOn(confirm, 'confirmAction').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const del = vi.spyOn(api, 'deleteTag').mockResolvedValue(ok);
    await deleteTag(ctx, { tag: 'v1', local: false, remote: 'origin' }, null);
    expect(ask.mock.calls[0][0].arm).toBe("Click again to delete v1 from origin (can't be undone)");
    expect(del).not.toHaveBeenCalled();
    await deleteTag(ctx, { tag: 'v1', local: true, remote: 'origin' }, null);
    expect(ask.mock.calls[1][0].arm).toBe("Click again to delete v1 here and from origin (the remote delete can't be undone)");
    expect(del).toHaveBeenCalledWith(1, '/r', { name: 'v1', local: true, remote: 'origin' });
  });
});
