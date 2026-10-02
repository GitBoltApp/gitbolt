import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import * as prompt from '../ui/PromptDialog';
import { CREATE_KEY, createBranchAt } from './create';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const ok = { outcome: null, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null };

describe('Create branch (spec #2 §9.1)', () => {
  beforeEach(() => localStorage.clear());
  it('checks out by default from the toolbar, not from the menu, and remembers each', async () => {
    const ask = vi.spyOn(prompt, 'promptText');
    const create = vi.spyOn(api, 'createBranch').mockResolvedValue(ok as never);
    ask.mockResolvedValueOnce({ value: 'topic', checked: true });
    await createBranchAt(ctx, { sha: 'a'.repeat(40), ref: null }, 'toolbar');
    expect(ask.mock.calls[0][0].checkbox).toEqual({ label: 'Check out', initial: true });
    expect(create).toHaveBeenCalledWith(1, '/r', expect.objectContaining({ name: 'topic', checkout: true, start: 'a'.repeat(40), expect: { head: null, refs: { 'refs/heads/topic': null } } }), false);
    ask.mockResolvedValueOnce({ value: 'other', checked: true });
    await createBranchAt(ctx, { sha: 'b'.repeat(40), ref: 'refs/remotes/origin/x' }, 'menu');
    expect(ask.mock.calls[1][0].checkbox).toEqual({ label: 'Check out', initial: false });
    expect(JSON.parse(localStorage.getItem(CREATE_KEY)!)).toEqual({ toolbar: true, menu: true });
    expect(create).toHaveBeenLastCalledWith(1, '/r', expect.objectContaining({ startRef: 'refs/remotes/origin/x' }), false);
  });
  it('validates the name live', async () => {
    const ask = vi.spyOn(prompt, 'promptText').mockResolvedValue(null);
    await createBranchAt(ctx, { sha: 'a'.repeat(40), ref: null }, 'toolbar');
    const validate = ask.mock.calls[0][0].validate!;
    expect(validate('a..b')).toBe("A branch name can't contain ..");
    expect(validate('ok/name')).toBeNull();
  });
});
