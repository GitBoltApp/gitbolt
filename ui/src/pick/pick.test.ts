import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { shortSha } from '../format/sha';
import type { CommitRef } from '../repo/store';
import { useToast } from '../ui/toast';
import { sequenceToast, startSequence } from './pick';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const [A, B, H] = ['a', 'b', 'h'].map((c) => c.repeat(40));
const c = (oid: string): CommitRef => ({ oid, summary: `Fix ${oid[0]}`, merge: false });
const ok = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null }) as never;

afterEach(() => {
  vi.restoreAllMocks();
  useToast.getState().dismiss();
});

describe('the toasts (spec #3 §3.7)', () => {
  it('done, committed or staged', () => {
    expect(sequenceToast({ status: 'done', commits: 1, committed: true }, 'cherryPick', [c(A)], 'main')).toEqual({ message: `Cherry-picked ${shortSha(A)} onto main`, warning: false });
    expect(sequenceToast({ status: 'done', commits: 2, committed: true }, 'revert', [c(A), c(B)], 'main')).toEqual({ message: 'Reverted 2 commits', warning: false });
    expect(sequenceToast({ status: 'done', commits: 2, committed: false }, 'cherryPick', [c(A), c(B)], 'main')).toEqual({ message: 'Cherry-picked 2 commits without committing: the changes are staged', warning: false });
  });
  it('a pause says nothing (the commit panel takes over); a stop without committing warns', () => {
    expect(sequenceToast({ status: 'stopped', files: 3, at: A, applied: 0, committed: true }, 'cherryPick', [c(A)], 'main')).toBeNull();
    expect(sequenceToast({ status: 'stopped', files: 1, at: B, applied: 1, committed: false }, 'cherryPick', [c(B), c(A)], 'main')).toEqual({ message: `Stopped on conflicts in 1 file at ${shortSha(B)}: 1 of 2 applied, the rest weren't`, warning: true });
  });
});

describe('startSequence', () => {
  it('sends the oids newest first, the flag and HEAD as shown; toasts the outcome', async () => {
    const pick = vi.spyOn(api, 'cherryPick').mockResolvedValue(ok({ status: 'done', commits: 2, committed: true }));
    await startSequence(ctx, 'cherryPick', [c(B), c(A)], { noCommit: false, branch: 'main', head: H });
    expect(pick).toHaveBeenCalledWith(1, '/r', [B, A], { noCommit: false, confirmAutostash: false, expect: { head: H, refs: {} } });
    expect(useToast.getState().message).toBe('Cherry-picked 2 commits onto main');
  });
  it('revert goes to its own request', async () => {
    const revert = vi.spyOn(api, 'revert').mockResolvedValue(ok({ status: 'done', commits: 1, committed: false }));
    await startSequence(ctx, 'revert', [c(A)], { noCommit: true, branch: 'main', head: H });
    expect(revert).toHaveBeenCalledWith(1, '/r', [A], expect.objectContaining({ noCommit: true }));
    expect(useToast.getState().message).toBe(`Reverted ${shortSha(A)} without committing: the changes are staged`);
  });
});
