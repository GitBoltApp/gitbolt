import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { shortSha } from '../format/sha';
import type { CommitRef } from '../repo/store';
import { revealRestored } from '../stash/reveal';
import { useToast } from '../ui/toastStore';
import { sequenceToast, startSequence } from './pick';

vi.mock('../stash/reveal', () => ({ revealRestored: vi.fn(() => Promise.resolve()) }));

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const [A, B, H] = ['a', 'b', 'h'].map((c) => c.repeat(40));
const c = (oid: string): CommitRef => ({ oid, summary: `Fix ${oid[0]}`, merge: false });
const ok = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null }) as never;

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(revealRestored).mockClear();
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
  // UX R1 C.1: a commit that failed (the signer) leaves the pick paused, and says why.
  it('a pause whose commit failed names the error', () => {
    const o = { status: 'stopped', files: 0, at: A, applied: 0, committed: true, error: 'error: gpg failed to sign the data.' } as const;
    expect(sequenceToast(o, 'cherryPick', [c(A)], 'main')).toEqual({ message: `The cherry-pick couldn't commit at ${shortSha(A)}: gpg failed to sign the data. Its changes are staged.`, warning: true });
    expect(sequenceToast({ ...o, at: null }, 'revert', [c(A)], 'main')?.message).toBe("The revert couldn't commit: gpg failed to sign the data. Its changes are staged.");
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
  // UX R1 C.1: what's left uncommitted is shown: the WIP row selected, its first file open.
  it('reveals the WIP when nothing was committed, not after a commit or a pause', async () => {
    const pick = vi.spyOn(api, 'cherryPick');
    pick.mockResolvedValueOnce(ok({ status: 'done', commits: 1, committed: false }));
    await startSequence(ctx, 'cherryPick', [c(A)], { noCommit: true, branch: 'main', head: H });
    expect(revealRestored).toHaveBeenCalledTimes(1);
    expect(revealRestored).toHaveBeenCalledWith('t', '/r', expect.any(Promise), false);
    pick.mockResolvedValueOnce(ok({ status: 'stopped', files: 2, at: A, applied: 0, committed: false }));
    await startSequence(ctx, 'cherryPick', [c(A)], { noCommit: true, branch: 'main', head: H });
    expect(revealRestored).toHaveBeenCalledTimes(2);
    // Committed, or paused (ConflictBanner reveals a pause, once per stop): nothing here.
    pick.mockResolvedValueOnce(ok({ status: 'done', commits: 1, committed: true }));
    await startSequence(ctx, 'cherryPick', [c(A)], { noCommit: false, branch: 'main', head: H });
    pick.mockResolvedValueOnce(ok({ status: 'stopped', files: 0, at: A, applied: 0, committed: true, error: 'gpg failed' }));
    await startSequence(ctx, 'cherryPick', [c(A)], { noCommit: false, branch: 'main', head: H });
    expect(revealRestored).toHaveBeenCalledTimes(2);
  });
});
