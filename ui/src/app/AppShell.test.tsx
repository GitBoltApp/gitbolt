import { act, render, screen, waitFor } from '@testing-library/react';
import { X } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../api/gen/AppEvent';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';

const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: `commit ${id}`, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graphFor = (repo: number): GraphPayload => ({ rows: [row(`r${repo}c1`), row(`r${repo}c0`)], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: false }, truncated: false });
const ids: Record<string, number> = { '/a': 1, '/b': 2 };

const listeners = vi.hoisted(() => new Set<(ev: AppEvent) => void>());
const api = vi.hoisted(() => ({
  openRepo: vi.fn(),
  graph: vi.fn(),
  sidebar: vi.fn(async () => ({ locals: [], remotes: [], worktrees: [], stashes: [], tags: [] })),
  repoInfo: vi.fn(async () => ({ remotes: [], mainWorktree: null, commonDir: '/x/.git' })),
  watchRepo: vi.fn(async () => null),
  unwatchRepo: vi.fn(async () => null),
  saveProfile: vi.fn(async () => null),
  saveSettings: vi.fn(async () => null),
  commandLog: vi.fn(async () => []),
}));
vi.mock('../api/client', () => ({
  api,
  errorMessage: (e: unknown) => String(e),
  onEvent: (h: (ev: AppEvent) => void) => { listeners.add(h); return () => { listeners.delete(h); }; },
}));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { AppShell } = await import('./AppShell');
const { EMPTY_PROFILE, useAppState } = await import('./state');
const { useRuntime } = await import('./runtime');
const { useTabViews } = await import('./tabStores');
const { registerAppSlot, registerTabSlot } = await import('./slots');
const { useRepoContext } = await import('./repoContext');
const { useRepoView } = await import('./seams1b');
const { openMenuAt } = await import('../menu/menuStore');

const emit = (ev: AppEvent) => act(() => { for (const h of [...listeners]) h(ev); });
const activate = (id: string) => act(() => useAppState.getState().updateProfile((p) => ({ ...p, activeTab: id })));
const graphCalls = (repo: number) => api.graph.mock.calls.filter((c) => c[0] === repo);

describe('AppShell: tabs inside <Activity> (spec §4.4, Review Focus 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    api.openRepo.mockImplementation(async (path: string) => ({ id: ids[path], path, name: path.slice(1) }));
    api.graph.mockImplementation(async (repo: number) => graphFor(repo));
    useRuntime.setState({ tabs: {} });
    useTabViews.setState({ views: {} });
    useAppState.setState({
      loaded: true,
      profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 'a', kind: 'repo', path: '/a', alias: null }, { id: 'b', kind: 'repo', path: '/b', alias: null }], activeTab: 'a' },
    });
  });
  afterEach(() => { document.title = ''; });

  it('only the active tab loads, watches and listens; switching moves all three', async () => {
    render(<AppShell />);
    expect(await screen.findByText('commit r1c1')).toBeInTheDocument();
    await waitFor(() => expect(api.watchRepo).toHaveBeenCalledWith(1));
    expect(api.openRepo).toHaveBeenCalledTimes(1); // restored tabs load when first shown
    // The shown tab's listener, plus the app's one for op and auth events (`useGlobalEvents`).
    expect(listeners.size).toBe(2);
    expect(document.title).toBe('GitBolt — a');

    activate('b');
    expect(await screen.findByText('commit r2c1')).toBeInTheDocument();
    await waitFor(() => expect(api.unwatchRepo).toHaveBeenCalledWith(1));
    await waitFor(() => expect(api.watchRepo).toHaveBeenCalledWith(2));
    expect(listeners.size).toBe(2);
    // The hidden tab ignores its repo's events; the shown one refreshes on them.
    const before = graphCalls(1).length;
    emit({ type: 'refsUpdated', repo: 1 });
    emit({ type: 'repoChanged', repo: 2, kinds: [], worktrees: [] });
    await waitFor(() => expect(graphCalls(2).length).toBe(2));
    expect(graphCalls(1).length).toBe(before);
    // The hidden tab's DOM and state survive.
    expect(screen.getByText('commit r1c1', { exact: true })).not.toBeVisible();

    // Back to a: the cached graph at once, then, once watched again, an in-place update: watch
    // first, then a plain graph (the watcher's first pass refreshed the status cache, W2-B).
    const graphsBefore = graphCalls(1).length;
    api.watchRepo.mockClear();
    activate('a');
    expect(screen.getByText('commit r1c1')).toBeVisible();
    await waitFor(() => expect(graphCalls(1).length).toBe(graphsBefore + 1));
    expect(api.watchRepo).toHaveBeenCalledWith(1);
    const graphAt = api.graph.mock.invocationCallOrder.at(-1)!;
    expect(api.watchRepo.mock.invocationCallOrder[0]).toBeLessThan(graphAt);
    expect(graphCalls(1).at(-1)?.[2]).toEqual({ pin: undefined });
    expect(api.openRepo).toHaveBeenCalledTimes(2);
  });

  it('a stale active tab id is repaired to the tab shown, so the shortcuts act on it', async () => {
    act(() => useAppState.setState({ profile: { ...useAppState.getState().profile, activeTab: 'gone' } }));
    render(<AppShell />);
    await screen.findByText('commit r1c1');
    await waitFor(() => expect(useAppState.getState().profile.activeTab).toBe('a'));
    // No tabs left: no active one either.
    act(() => useAppState.setState({ profile: { ...useAppState.getState().profile, tabs: [], activeTab: 'a' } }));
    await waitFor(() => expect(useAppState.getState().profile.activeTab).toBeNull());
  });

  it('a closed tab lets go of its runtime and view state', async () => {
    render(<AppShell />);
    await screen.findByText('commit r1c1');
    expect(useTabViews.getState().views.a).toBeDefined();
    act(() => useAppState.getState().updateProfile((p) => ({ ...p, tabs: p.tabs.filter((t) => t.id !== 'a'), activeTab: 'b' })));
    await waitFor(() => expect(useRuntime.getState().tabs.a).toBeUndefined());
    expect(useTabViews.getState().views.a).toBeUndefined();
    await waitFor(() => expect(api.unwatchRepo).toHaveBeenCalledWith(1));
  });

  it('slots: the header in the shell, the toolbar in each repo tab, with its contexts', async () => {
    function Toolbar() {
      const { tabId, path } = useRepoContext();
      const rows = useRepoView((s) => s.graph.rows.length);
      return <div>toolbar {tabId} {path} {rows}</div>;
    }
    const offs = [registerAppSlot('header', 'test.header', () => <div>the header</div>), registerTabSlot('toolbar', 'test.toolbar', Toolbar)];
    render(<AppShell />);
    expect(screen.getByText('the header')).toBeInTheDocument();
    expect(await screen.findByText('toolbar a /a 2')).toBeInTheDocument();
    act(() => offs.forEach((f) => f()));
    expect(screen.queryByText('the header')).toBeNull();
  });

  it('mounts the app\'s one context menu (R1): a menu opened anywhere shows', async () => {
    render(<AppShell />);
    await screen.findByText('commit r1c1');
    act(() => openMenuAt(document.body, [{ kind: 'action', id: 'x', label: 'Hello menu', icon: X, tooltip: 'A row', run: () => {} }]));
    expect(screen.getByTestId('context-menu')).toHaveTextContent('Hello menu');
  });
});
