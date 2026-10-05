import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: { lastPush: vi.fn(async () => null) }, errorMessage: String, onEvent: () => () => {} }));

const { Sidebar } = await import('./Sidebar');
const { EMPTY_GRAPH } = await import('../app/testShell');
const { createRepoViewStore, RepoViewContext } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');
const { RepoContext } = await import('../app/repoContext');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { patchForge, useForge } = await import('../forge/mrStore');

const group = (name: string) => ({ name, host: 'github.com', hostKind: 'github' as const, branches: [{ name: 'dev', fullName: `refs/remotes/${name}/dev`, target: 'm'.repeat(40), tipTime: 0, summary: '', author: '' }] });
const ctx = { tabId: 't', repoId: 4, path: '/r', worktree: '/r', info: null };
const wrap = (node: ReactNode) => <RepoViewContext value={createRepoViewStore(4, '/r', EMPTY_GRAPH, fakeServices())}><RepoContext value={ctx}>{node}</RepoContext></RepoViewContext>;

beforeEach(() => {
  useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
  useRuntime.setState({ tabs: {} });
  useRuntime.getState().patch('t', { status: 'ready', sidebar: { locals: [], remotes: [group('alice'), group('origin')], worktrees: [], stashes: [], tags: [] } });
  useForge.setState({ byTab: {} });
});

describe('the Remote rows and the forge target', () => {
  it('marks the main remote with a dim chip, and only that one', () => {
    patchForge('t', { kind: 'github', target: 'origin', targetChosen: true });
    render(wrap(<Sidebar />));
    expect(screen.getAllByText('main')).toHaveLength(1);
    expect(document.querySelector('[data-remote-main="origin"]')).not.toBeNull();
    expect(document.querySelector('[data-remote-main="alice"]')).toBeNull();
  });

  it('tells the automatic pick from the choice', () => {
    patchForge('t', { kind: 'github', target: 'origin', targetChosen: false });
    render(wrap(<Sidebar />));
    expect(screen.getByText('main (auto)')).toBeInTheDocument();
    expect(screen.queryByText('main')).toBeNull();
  });

  it("hints why a remote isn't on the forge", () => {
    patchForge('t', { kind: 'github', target: 'origin', remoteErrors: { alice: 'Not found: alice/widget' } });
    render(wrap(<Sidebar />));
    expect(screen.getByRole('img', { name: 'Not on the forge: Not found: alice/widget' })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-remote-lookup-warning]')).toHaveLength(1);
  });
});
