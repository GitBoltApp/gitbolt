import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';

const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graphFor = (repo: number): GraphPayload => ({ rows: [row(`r${repo}`)], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [] });
const ids: Record<string, number> = { '/a': 1, '/b': 2, '/c': 3 };

const api = vi.hoisted(() => ({
  openRepo: vi.fn(),
  graph: vi.fn(),
  sidebar: vi.fn(async () => ({ locals: [], remotes: [], worktrees: [], stashes: [], tags: [] })),
  repoInfo: vi.fn(async () => ({ remotes: [], mainWorktree: null, commonDir: '/x/.git' })),
  watchRepo: vi.fn(async () => null),
  unwatchRepo: vi.fn(async () => null),
  saveProfile: vi.fn(async () => null),
  saveSettings: vi.fn(async () => null),
}));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));
// Counts each repo view's renders (the whole tab tree below RepoTab re-renders with it).
const renders = vi.hoisted(() => new Map<number, number>());
vi.mock('../repo/RepoView', () => ({
  RepoView: ({ repo }: { repo: number }) => {
    renders.set(repo, (renders.get(repo) ?? 0) + 1);
    return <div>view {repo}</div>;
  },
}));

const { AppShell } = await import('./AppShell');
const { EMPTY_PROFILE, useAppState } = await import('./state');
const { useRuntime } = await import('./runtime');
const { useTabViews } = await import('./tabStores');

const activate = (id: string) => act(() => useAppState.getState().updateProfile((p) => ({ ...p, activeTab: id })));

describe('RepoTab under <Activity>', () => {
  beforeEach(() => {
    renders.clear();
    api.openRepo.mockImplementation(async (path: string) => ({ id: ids[path], path, name: path.slice(1), worktree: path }));
    api.graph.mockImplementation(async (repo: number) => graphFor(repo));
    useRuntime.setState({ tabs: {} });
    useTabViews.setState({ views: {} });
    const tabs = ['a', 'b', 'c'].map((id) => ({ id, kind: 'repo' as const, path: `/${id}`, alias: null }));
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs, activeTab: 'a' } });
  });

  it('a tab switch does not re-render the tabs that stay hidden', async () => {
    render(<AppShell />);
    await screen.findByText('view 1');
    activate('b');
    await screen.findByText('view 2');
    activate('c');
    await screen.findByText('view 3');
    await waitFor(() => expect(api.watchRepo).toHaveBeenCalledWith(3));
    const a = renders.get(1)!;
    // c → b → c: a stays hidden throughout.
    activate('b');
    activate('c');
    await waitFor(() => expect(api.unwatchRepo).toHaveBeenCalledWith(2));
    expect(renders.get(1)).toBe(a);
  });
});
