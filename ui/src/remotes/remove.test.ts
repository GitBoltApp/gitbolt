import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import * as state from '../app/state';
import { useAppState } from '../app/state';
import { useRuntime } from '../app/runtime';
import * as bus from '../forge/accountsBus';
import * as confirm from '../ui/ConfirmDialog';
import { namesUpTo3, removeRemote, removeRemoteText } from './remove';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const res = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null });
const branch = (name: string) => ({ name, fullName: `refs/remotes/origin/${name}`, target: 'a'.repeat(40), tipTime: 0, summary: '', author: '' });
const local = (name: string, upstream: string | null) => ({ name, fullName: `refs/heads/${name}`, upstream } as never);
const sidebar = (locals: never[]): SidebarPayload => ({
  locals,
  remotes: [
    { name: 'origin', host: null, hostKind: 'generic', branches: [branch('main'), branch('feature'), branch('x')] },
    { name: 'origin/fork', host: null, hostKind: 'generic', branches: [branch('main')] },
  ],
  worktrees: [], stashes: [], tags: [],
});

describe('Remove remote', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names up to three, then how many more', () => {
    expect(namesUpTo3(['a'])).toBe('a');
    expect(namesUpTo3(['a', 'b'])).toBe('a and b');
    expect(namesUpTo3(['a', 'b', 'c'])).toBe('a, b and c');
    expect(namesUpTo3(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });

  it('the confirmation counts its remote branches and the local branches tracking it', () => {
    const locals = [local('main', 'refs/remotes/origin/main'), local('a', 'refs/remotes/origin/a'), local('b', 'refs/remotes/origin/b'), local('c', 'refs/remotes/origin/c'), local('forked', 'refs/remotes/origin/fork/main'), local('solo', null)];
    expect(removeRemoteText('origin', sidebar(locals))).toEqual({
      title: 'Remove the remote origin?',
      body: 'Its 3 remote branches leave this repository. 4 local branches tracking it lose their upstream: main, a, b and 1 more. Undo puts it all back.',
      arm: 'Click again to remove origin',
    });
    expect(removeRemoteText('origin/fork', sidebar(locals)).body).toBe('Its 1 remote branch leaves this repository. 1 local branch tracking it loses its upstream: forked. Undo puts it all back.');
    expect(removeRemoteText('origin', sidebar([])).body).toBe('Its 3 remote branches leave this repository. Undo puts it all back.');
    expect(removeRemoteText('origin', sidebar([]), true).body).toBe('Its 3 remote branches leave this repository. The main remote goes back to Automatic. Undo puts the rest back.');
  });

  it('arms in place (danger), then sends the write; a chosen main remote goes back to Automatic', async () => {
    const ask = vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true);
    const rm = vi.spyOn(api, 'removeRemote').mockResolvedValue(res(null) as never);
    const forge = vi.spyOn(bus, 'notifyForgeAccountsChanged');
    const saved = vi.spyOn(state, 'flushSaves').mockResolvedValue(undefined as never);
    useRuntime.getState().patch('t', { repo: { id: 1, path: '/r', name: 'r', worktree: '/r' }, worktree: '/r', sidebar: sidebar([local('main', 'refs/remotes/origin/main')]) });
    useAppState.getState().updateRepo('/r', (r) => ({ ...r, forgeTargetRemote: 'origin' }));
    await removeRemote(ctx, 'origin');
    expect(ask.mock.calls[0][0]).toMatchObject({ title: 'Remove the remote origin?', confirmLabel: 'Remove remote', danger: true, caption: expect.stringContaining('1 local branch tracking it loses its upstream: main. The main remote goes back to Automatic. Undo puts the rest back.') });
    expect(rm).toHaveBeenCalledWith(1, '/r', 'origin');
    expect(useAppState.getState().profile.repos['/r']?.forgeTargetRemote).toBeNull();
    expect(saved).toHaveBeenCalled();
    expect(forge).toHaveBeenCalled();
  });

  it('a no sends nothing', async () => {
    vi.spyOn(confirm, 'confirmAction').mockResolvedValue(false);
    const rm = vi.spyOn(api, 'removeRemote');
    await removeRemote(ctx, 'origin');
    expect(rm).not.toHaveBeenCalled();
  });
});
