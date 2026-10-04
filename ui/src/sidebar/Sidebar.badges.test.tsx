import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBranch } from '../api/gen/LocalBranch';

vi.mock('../api/client', () => ({ api: { lastPush: vi.fn(async () => null) }, errorMessage: String, onEvent: () => () => {} }));
const nav = vi.hoisted(() => ({ selectCommit: vi.fn(() => true) }));
vi.mock('../app/graphNav', () => nav);
const poll = vi.hoisted(() => ({ openMrView: vi.fn(), loadMrDetail: vi.fn(async () => {}) }));
vi.mock('../forge/poll', () => poll);

const { Sidebar } = await import('./Sidebar');
const { HoverCard } = await import('./HoverCard');
const { EMPTY_GRAPH } = await import('../app/testShell');
const { createRepoViewStore, RepoViewContext } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');
const { RepoContext } = await import('../app/repoContext');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { patchForge, useForge } = await import('../forge/mrStore');
const { mrOf } = await import('../forge/testMrs');

const branch = (name: string, upstream: string | null): LocalBranch => ({ name, fullName: `refs/heads/${name}`, target: name.padEnd(40, '0'), upstream, ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '', isHead: false, worktree: null, checkedOut: null, pushTarget: null, pushBehind: null, rewritten: null });
const ctx = { tabId: 't', repoId: 4, path: '/r', worktree: '/r', info: null };
const wrap = (node: ReactNode) => <RepoViewContext value={createRepoViewStore(4, '/r', EMPTY_GRAPH, fakeServices())}><RepoContext value={ctx}>{node}</RepoContext></RepoViewContext>;

beforeEach(() => {
  vi.clearAllMocks();
  useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
  useRuntime.setState({ tabs: {} });
  useRuntime.getState().patch('t', { status: 'ready', sidebar: { locals: [branch('dev', 'refs/remotes/origin/dev'), branch('topic', null)], remotes: [], worktrees: [], stashes: [], tags: [] } });
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', byRef: { 'refs/remotes/origin/dev': mrOf(12, { title: 'Dev work' }) } });
});

describe('the badge on Local rows (spec #4 §5)', () => {
  it("shows on the branch whose upstream has an MR; a click opens it without jumping to the commit", () => {
    render(wrap(<Sidebar />));
    const row = screen.getByRole('treeitem', { name: 'dev' });
    const badge = within(row).getByRole('button', { name: 'Merge request !12: open' });
    expect(within(screen.getByRole('treeitem', { name: 'topic' })).queryByRole('button')).toBeNull();
    fireEvent.click(badge);
    expect(poll.openMrView).toHaveBeenCalledWith('t', 12);
    expect(nav.selectCommit).not.toHaveBeenCalled();
  });

  it("the row's hover card gains the MR block", () => {
    const item = { key: 'refs/heads/dev', kind: 'local' as const, name: 'dev', target: null, time: 0, branch: branch('dev', 'refs/remotes/origin/dev') };
    render(wrap(<HoverCard item={item} repoId={4} top={0} left={0} />));
    expect(screen.getByLabelText('Merge request !12 details')).toHaveTextContent('!12 Dev work');
  });
});
