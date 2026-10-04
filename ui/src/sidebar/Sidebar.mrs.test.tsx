import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  lastPush: vi.fn(async () => null),
  forgeMrList: vi.fn(async (_repo: number, filter: string) => ({ kind: 'gitlab', remote: 'origin', project: {}, filter, mrs: [], fetchedAt: 1, pollIntervalSecs: null })),
}));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../app/graphNav', () => ({ selectCommit: vi.fn(() => true) }));
const poll = vi.hoisted(() => ({ openMrView: vi.fn(), loadMrDetail: vi.fn(async () => {}) }));
vi.mock('../forge/poll', () => poll);

const { Sidebar } = await import('./Sidebar');
const { EMPTY_GRAPH } = await import('../app/testShell');
const { createRepoViewStore, RepoViewContext } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');
const { RepoContext } = await import('../app/repoContext');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { useMenu } = await import('../menu/menuStore');
const { forgeOf, patchForge, useForge } = await import('../forge/mrStore');
const { mrOf, projectOf } = await import('../forge/testMrs');

const ctx = { tabId: 't', repoId: 4, path: '/r', worktree: '/r', info: null };
const order = () => screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
const show = () => render(<RepoViewContext value={createRepoViewStore(4, '/r', EMPTY_GRAPH, fakeServices())}><RepoContext value={ctx}><Sidebar /></RepoContext></RepoViewContext>);
const list = (mrs = [mrOf(12, { title: 'Dev work', pipeline: { status: 'success', webUrl: null } }), mrOf(5, { state: 'draft', title: 'Explore' })]) => ({ kind: 'gitlab' as const, remote: 'origin', project: projectOf(), filter: 'all' as const, mrs, fetchedAt: 1, pollIntervalSecs: null });

beforeEach(() => {
  vi.clearAllMocks();
  useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
  useRuntime.setState({ tabs: {} });
  useRuntime.getState().patch('t', { status: 'ready', repo: { id: 4 } as never, sidebar: { locals: [], remotes: [], worktrees: [], stashes: [], tags: [] } });
  useForge.setState({ byTab: {} });
});

describe('the sidebar MR/PR section (spec #4 §2, §5)', () => {
  it('is not there without a forge target', () => {
    show();
    expect(order()).toEqual(['Local', 'Remote', 'Worktrees', 'Stashes', 'Tags']);
  });

  it('sits after Remote and lists the open ones, each with its state and pipeline; a click opens one', () => {
    patchForge('t', { kind: 'gitlab', list: list() });
    show();
    expect(order()).toEqual(['Local', 'Remote', 'Merge requests', 'Worktrees', 'Stashes', 'Tags']);
    const panel = screen.getByRole('region', { name: 'Merge requests' });
    expect(within(panel).getByLabelText('Merge requests count')).toHaveTextContent('2');
    const row = within(panel).getByRole('treeitem', { name: '!12 Dev work' });
    expect(row.querySelector('.mr-state-icon[data-state="open"]')).toBeTruthy();
    expect(row.querySelector('.mr-pipeline-icon[data-status="success"]')).toBeTruthy();
    fireEvent.click(row);
    expect(poll.openMrView).toHaveBeenCalledWith('t', 12);
    fireEvent.keyDown(within(panel).getByRole('tree'), { key: 'ArrowDown' });
    fireEvent.keyDown(within(panel).getByRole('tree'), { key: 'Enter' });
    expect(poll.openMrView).toHaveBeenLastCalledWith('t', 5);
  });

  it('is "Pull requests" on GitHub, and says when its list is empty', () => {
    patchForge('t', { kind: 'github', list: { ...list([]), kind: 'github' } });
    show();
    expect(within(screen.getByRole('region', { name: 'Pull requests' })).getByText('No open pull requests')).toBeTruthy();
  });

  it('the filter is chosen from its menu and kept per repository', async () => {
    patchForge('t', { kind: 'gitlab', list: list() });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Filter merge requests: All' }));
    const mine = useMenu.getState().rows?.find((r) => r.kind === 'action' && r.label === 'Mine');
    expect(mine).toBeTruthy();
    await act(async () => { if (mine?.kind === 'action') mine.run(); });
    expect(useAppState.getState().profile.repos['/r']?.mrFilter).toBe('mine');
    expect(forgeOf('t').filter).toBe('mine');
    expect(api.forgeMrList).toHaveBeenCalledWith(4, 'mine');
    expect(screen.getByRole('button', { name: 'Filter merge requests: Mine' })).toBeTruthy();
  });

  it('warns in its header when the last poll failed, keeping the rows', () => {
    patchForge('t', { kind: 'gitlab', list: list(), error: 'boom', updatedAt: Date.now() - 60_000 });
    show();
    const panel = screen.getByRole('region', { name: 'Merge requests' });
    expect(within(panel).getByRole('img', { name: /^Couldn't refresh: boom\. Last updated/ })).toBeTruthy();
    expect(within(panel).getByRole('treeitem', { name: '!12 Dev work' })).toBeTruthy();
  });
});
