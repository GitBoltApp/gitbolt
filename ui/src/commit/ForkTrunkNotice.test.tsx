import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForkPayload } from '../api/gen/ForkPayload';
import type { GraphWorktree } from '../api/gen/GraphWorktree';

const h = vi.hoisted(() => ({ createBranchAt: vi.fn(async () => {}) }));
vi.mock('../api/client', () => ({ api: { saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null) } }));
vi.mock('../branches/create', () => ({ createBranchAt: h.createBranchAt }));
vi.mock('../repo/store', async () => {
  const { create } = await import('zustand');
  const state = create(() => ({ graph: { fork: undefined as ForkPayload | undefined, worktrees: [] as GraphWorktree[] } }));
  return { useRepoView: <T,>(sel: (s: ReturnType<typeof state.getState>) => T) => state(sel), testState: state };
});

const { RepoContext } = await import('../app/repoContext');
const { EMPTY_PROFILE, EMPTY_REPO_SETTINGS, useAppState } = await import('../app/state');
const { ForkTrunkNotice, forkTrunkBranch } = await import('./ForkTrunkNotice');
const { testState } = (await import('../repo/store')) as unknown as { testState: { setState(p: object): void } };

const HEAD = 'a'.repeat(40);
const FORK: ForkPayload = { fork: 'origin', original: 'upstream', host: 'github.com', hostKind: 'github', detectedBy: 'upstreamRemote', trunk: 'refs/remotes/upstream/main', forkTrunk: 'refs/remotes/origin/main', trunkBranches: ['refs/heads/main'] };
const wt = (path: string, branch: string | null): GraphWorktree => ({ path, branch, head: HEAD, isMain: path === '/r', locked: false, inProgress: null });
const ctx = { tabId: 't', repoId: 1, worktree: '/r' };

function setup(fork: ForkPayload | undefined, worktrees: GraphWorktree[], dismissed = false, hostOverrides = {}) {
  testState.setState({ graph: { fork, worktrees } });
  useAppState.setState({ profile: { ...EMPTY_PROFILE, hostOverrides, repos: { '/r': { ...EMPTY_REPO_SETTINGS, forkTrunkNoticeDismissed: dismissed } } } });
  return render(<RepoContext.Provider value={{ tabId: 't', repoId: 1, path: '/r', worktree: '/r', info: null }}><ForkTrunkNotice ctx={ctx} /></RepoContext.Provider>);
}
const notice = () => screen.queryByTestId('fork-trunk-notice');

beforeEach(() => h.createBranchAt.mockClear());
afterEach(cleanup);

describe('the fork trunk notice (committing to main in your fork)', () => {
  it('shows above Commit while the worktree is on a trunk branch of a fork', () => {
    setup(FORK, [wt('/r', 'refs/heads/main')]);
    expect(notice()).toHaveTextContent("You're committing to main in your fork. Changes for a pull request usually go on their own branch.");
    expect(screen.getByRole('button', { name: 'Create branch…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('says merge request when the original project is on GitLab, by detection or the host overrides', () => {
    setup({ ...FORK, host: 'gitlab.example.com', hostKind: 'gitlab' }, [wt('/r', 'refs/heads/main')]);
    expect(notice()).toHaveTextContent('Changes for a merge request usually go on their own branch.');
    cleanup();
    setup({ ...FORK, host: 'git.example.com', hostKind: 'generic' }, [wt('/r', 'refs/heads/main')]);
    expect(notice()).toHaveTextContent('Changes for a pull request usually go on their own branch.');
    cleanup();
    setup({ ...FORK, host: 'git.example.com', hostKind: 'generic' }, [wt('/r', 'refs/heads/main')], false, { 'git.example.com': 'gitlab' });
    expect(notice()).toHaveTextContent('Changes for a merge request usually go on their own branch.');
  });

  it('is hidden off a trunk branch, outside a fork, on another worktree\'s main, and once dismissed', () => {
    setup(FORK, [wt('/r', 'refs/heads/feature')]);
    expect(notice()).toBeNull();
    cleanup();
    setup(undefined, [wt('/r', 'refs/heads/main')]);
    expect(notice()).toBeNull();
    cleanup();
    setup(FORK, [wt('/r', 'refs/heads/feature'), wt('/r-main', 'refs/heads/main')]);
    expect(notice()).toBeNull();
    cleanup();
    setup(FORK, [wt('/r', null)]);
    expect(notice()).toBeNull();
    cleanup();
    setup(FORK, [wt('/r', 'refs/heads/main')], true);
    expect(notice()).toBeNull();
  });

  it('names any trunk branch the core lists (one tracking the fork\'s main)', () => {
    const fork = { ...FORK, trunkBranches: ['refs/heads/main', 'refs/heads/mine'] };
    expect(forkTrunkBranch({ fork, worktrees: [wt('/r', 'refs/heads/mine')] }, '/r')).toEqual({ branch: 'refs/heads/mine', head: HEAD });
    setup(fork, [wt('/r', 'refs/heads/mine')]);
    expect(notice()).toHaveTextContent("You're committing to mine in your fork.");
  });

  it('Create branch… starts the new-branch flow from HEAD, coming back to the WIP after', () => {
    setup(FORK, [wt('/r', 'refs/heads/main')]);
    fireEvent.click(screen.getByRole('button', { name: 'Create branch…' }));
    // No start ref: the new branch doesn't track the local main.
    expect(h.createBranchAt).toHaveBeenCalledWith(ctx, { sha: HEAD, ref: null }, { keepSelection: true });
  });

  it('Dismiss hides it for this repo, remembered in the profile\'s repo prefs; the keyboard goes to Commit', () => {
    testState.setState({ graph: { fork: FORK, worktrees: [wt('/r', 'refs/heads/main')] } });
    useAppState.setState({ profile: { ...EMPTY_PROFILE, repos: { '/r': EMPTY_REPO_SETTINGS } } });
    render(
      <RepoContext.Provider value={{ tabId: 't', repoId: 1, path: '/r', worktree: '/r', info: null }}>
        <div className="commit-box"><ForkTrunkNotice ctx={ctx} /><button type="button" className="commit-button">Commit</button></div>
      </RepoContext.Provider>,
    );
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Commit' }));
    expect(useAppState.getState().profile.repos['/r'].forkTrunkNoticeDismissed).toBe(true);
  });
});
