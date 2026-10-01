import { fireEvent, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBranch } from '../api/gen/LocalBranch';

vi.mock('../api/client', () => ({ api: { lastPush: vi.fn(async () => null) }, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../app/graphNav', () => ({ selectCommit: vi.fn(() => true) }));

const { Sidebar } = await import('./Sidebar');
const { useMenu } = await import('../menu/menuStore');
const { EMPTY_GRAPH } = await import('../app/testShell');
const { createRepoViewStore, RepoViewContext } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');
const { RepoContext } = await import('../app/repoContext');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, EMPTY_REPO_SETTINGS, useAppState } = await import('../app/state');

const branch = (name: string, isHead = false): LocalBranch => ({ name, fullName: `refs/heads/${name}`, target: name.padEnd(40, '0'), upstream: null, ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '', isHead, worktree: null });
const ctx = { tabId: 't', repoId: 4, path: '/r', info: null };
const profile = () => useAppState.getState().profile;
const panel = (name: string) => screen.getByRole('region', { name });
const order = () => screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));

describe('Sidebar panels', () => {
  beforeEach(() => {
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
    useRuntime.setState({ tabs: {} });
    useRuntime.getState().patch('t', {
      status: 'ready',
      sidebar: {
        locals: [branch('main', true), branch('feature/login'), branch('hotfix')],
        remotes: [{ name: 'origin', host: null, hostKind: 'generic', branches: [{ name: 'main', fullName: 'refs/remotes/origin/main', target: 'm'.repeat(40), tipTime: 0, summary: '', author: '' }] }],
        worktrees: [{ path: '/r', name: 'r', branch: 'main', head: 'h'.repeat(40), isMain: true, isCurrent: true }, { path: '/w', name: 'w', branch: null, head: 'i'.repeat(40), isMain: false, isCurrent: false }], stashes: [], tags: [{ name: 'v1', fullName: 'refs/tags/v1', target: 't'.repeat(40), time: 0 }],
      },
    });
  });
  const renderIt = () => render(<RepoViewContext value={createRepoViewStore(4, '/r', EMPTY_GRAPH, fakeServices())}><RepoContext value={ctx}><Sidebar /></RepoContext></RepoViewContext>);

  it('stacks a panel per section, with counts', () => {
    renderIt();
    expect(order()).toEqual(['Local', 'Remote', 'Worktrees', 'Stashes', 'Tags']);
    expect(within(panel('Local')).getByLabelText('Local count')).toHaveTextContent('3');
    expect(within(panel('Remote')).getByLabelText('Remote count')).toHaveTextContent('1');
    expect(within(panel('Stashes')).getByLabelText('Stashes count')).toHaveTextContent('0');
  });

  it('ahead/behind shows each count with a 12px arrow icon, labelled for screen readers (K67)', () => {
    const s = useRuntime.getState().tabs.t.sidebar!;
    useRuntime.getState().patch('t', { sidebar: { ...s, locals: [{ ...branch('hotfix'), upstream: 'refs/remotes/origin/hotfix', ahead: 10, behind: 11 }] } });
    renderIt();
    const ab = within(panel('Local')).getByLabelText('10 ahead, 11 behind');
    expect(ab).toHaveTextContent('1011');
    const icons = ab.querySelectorAll('svg');
    expect(icons).toHaveLength(2);
    expect([...icons].map((i) => i.getAttribute('width'))).toEqual(['12', '12']);
  });

  it('the filter filters every panel; counts follow, empty panels say so', () => {
    renderIt();
    fireEvent.change(screen.getByLabelText('Filter branches'), { target: { value: 'main' } });
    expect(within(panel('Local')).getByLabelText('Local count')).toHaveTextContent('1');
    expect(within(panel('Remote')).getByLabelText('Remote count')).toHaveTextContent('1');
    expect(within(panel('Tags')).getByLabelText('Tags count')).toHaveTextContent('0');
    expect(within(panel('Tags')).getByText('No matches')).toBeInTheDocument();
  });

  it('a collapsed panel shrinks to its header in place and keeps its count', () => {
    renderIt();
    fireEvent.click(within(panel('Remote')).getByRole('button', { name: 'Remote' }));
    expect(order()).toEqual(['Local', 'Remote', 'Worktrees', 'Stashes', 'Tags']);
    expect(within(panel('Remote')).queryByRole('tree')).toBeNull();
    expect(within(panel('Remote')).getByLabelText('Remote count')).toHaveTextContent('1');
    expect(profile().repos['/r'].collapsed).toContain('section:remote');
  });

  it('a divider between expanded panels is a focusable separator; arrow keys resize and persist', () => {
    useAppState.getState().updateProfile((p) => ({ ...p, sidebarPanels: { local: 200, remote: 200, worktrees: 10, stashes: 10, tags: 10 } }));
    renderIt();
    const sep = screen.getByRole('separator', { name: 'Resize Local and Remote' });
    expect(sep).toHaveAttribute('tabindex', '0');
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.keyDown(sep, { key: 'ArrowDown' });
    expect(profile().sidebarPanels.local).toBe(before + 24);
    expect(Number(screen.getByRole('separator', { name: 'Resize Local and Remote' }).getAttribute('aria-valuenow'))).toBe(before + 24);
  });

  it('the (<) button switches to the narrow strip; its icons show filtered counts; (>) expands', () => {
    renderIt();
    fireEvent.change(screen.getByLabelText('Filter branches'), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(profile().sidebarNarrow).toBe(true);
    expect(screen.getByRole('complementary', { name: 'Sidebar (collapsed)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Local (1)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(profile().sidebarNarrow).toBe(false);
    expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeInTheDocument();
  });

  it('loads an old-shape profile (no sidebarPanels, per-remote collapse keys) without crashing', () => {
    const { sidebarPanels: _drop, ...old } = profile();
    useAppState.setState({ profile: { ...old, repos: { '/r': { ...EMPTY_REPO_SETTINGS, collapsed: ['section:remote:origin', 'origin:feature'], sidebarSort: { 'remote:origin': 'recent' } } } } as never });
    renderIt();
    expect(order()).toEqual(['Local', 'Remote', 'Worktrees', 'Stashes', 'Tags']);
    expect(within(panel('Remote')).getByLabelText('Remote count')).toHaveTextContent('1');
  });

  it('marks the checked-out branch and the current worktree (green rows), and only those', () => {
    renderIt();
    const heads = screen.getAllByRole('treeitem').filter((e) => e.classList.contains('is-head')).map((e) => e.getAttribute('aria-label'));
    expect(heads).toEqual(['main', 'r']);
    expect(within(panel('Local')).getByLabelText('current branch')).toHaveClass('co-check');
  });

  it('worktree rows: a house for the main checkout, a pine tree for linked ones; hover shows path, branch, sha (K75)', () => {
    renderIt();
    const wt = within(panel('Worktrees'));
    const main = wt.getByRole('treeitem', { name: 'r' });
    const linked = wt.getByRole('treeitem', { name: 'w' });
    expect(main.querySelector('svg')).toHaveClass('lucide-house');
    expect(main.querySelector('svg')).toHaveAttribute('aria-label', 'current worktree');
    expect(linked.querySelector('svg')).toHaveClass('lucide-tree-pine');
    fireEvent.pointerEnter(linked);
    const card = screen.getByRole('tooltip');
    expect(card).toHaveTextContent('/w');
    expect(card).toHaveTextContent('Detached at iiiiii');
    expect(card).toHaveTextContent('Linked worktree');
    fireEvent.pointerLeave(linked);
    fireEvent.pointerEnter(main);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Branch: main');
    expect(screen.getByRole('tooltip')).toHaveTextContent('HEAD hhhhhh');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Main checkout · current');
  });

  it('a strip icon expands the sidebar with that panel open', () => {
    useAppState.getState().updateProfile((p) => ({ ...p, sidebarNarrow: true }));
    useAppState.getState().updateRepo('/r', (r) => ({ ...r, collapsed: ['section:tags'] }));
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Tags (1)' }));
    expect(profile().sidebarNarrow).toBe(false);
    expect(profile().repos['/r'].collapsed).not.toContain('section:tags');
    expect(within(panel('Tags')).getByRole('tree')).toBeInTheDocument();
  });

  it('double-clicking the sidebar edge restores the default width; a panel divider evens out just its two panels (K73)', () => {
    useAppState.setState({ profile: { ...profile(), sidebarWidth: 400, sidebarPanels: { local: 300, remote: 100, worktrees: 120, stashes: 40, tags: 40 } } });
    renderIt();
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize sidebar' }));
    expect(profile().sidebarWidth).toBe(240);
    fireEvent.doubleClick(screen.getAllByRole('separator', { name: /^Resize Local and Remote/ })[0]);
    const after = profile().sidebarPanels;
    // Local and Remote now share their combined height evenly…
    expect(Math.abs(after.local - after.remote)).toBeLessThanOrEqual(1);
    // …and a panel the divider doesn't touch is not reset.
    expect(after.worktrees).not.toBeUndefined();
  });
});

describe('Sidebar item menus (plan 1C Task 15b)', () => {
  const rowsOpen = () => useMenu.getState().rows?.map((r) => (r.kind === 'separator' ? '---' : r.label)) ?? null;
  beforeEach(() => {
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
    useRuntime.setState({ tabs: {} });
    useRuntime.getState().patch('t', {
      status: 'ready',
      sidebar: {
        locals: [branch('main', true), branch('hotfix')],
        remotes: [{ name: 'origin', host: null, hostKind: 'generic', branches: [{ name: 'main', fullName: 'refs/remotes/origin/main', target: 'm'.repeat(40), tipTime: 0, summary: '', author: '' }] }],
        worktrees: [{ path: '/w', name: 'w', branch: null, head: 'i'.repeat(40), isMain: false, isCurrent: false }],
        stashes: [{ index: 0, id: 's'.repeat(40), message: 'WIP on main', time: 0 }], tags: [{ name: 'v1', fullName: 'refs/tags/v1', target: 't'.repeat(40), time: 0 }],
      },
    });
    useMenu.getState().close();
  });
  afterEach(() => act(() => useMenu.getState().close()));
  const renderIt = () => render(<RepoViewContext value={createRepoViewStore(4, '/r', EMPTY_GRAPH, fakeServices())}><RepoContext value={ctx}><Sidebar /></RepoContext></RepoViewContext>);

  it('right-click on a branch, remote folder, tag, stash and worktree opens its menu', () => {
    renderIt();
    fireEvent.contextMenu(within(panel('Local')).getByRole('treeitem', { name: 'hotfix' }));
    expect(rowsOpen()).toContain('Copy branch name');
    expect(rowsOpen()).toContain('Show in graph');
    fireEvent.contextMenu(within(panel('Remote')).getAllByRole('treeitem')[0]);
    expect(rowsOpen()).toEqual(['Copy remote name', 'Copy URL']);
    fireEvent.contextMenu(within(panel('Tags')).getByRole('treeitem', { name: 'v1' }));
    expect(rowsOpen()).toContain('Copy tag name');
    fireEvent.contextMenu(within(panel('Stashes')).getByRole('treeitem', { name: /WIP on main/ }));
    expect(rowsOpen()).toContain('Copy message');
    fireEvent.contextMenu(within(panel('Worktrees')).getByRole('treeitem', { name: 'w' }));
    expect(rowsOpen()).toContain('Open in file manager');
  });

  it('a plain folder row has no menu', () => {
    useRuntime.getState().patch('t', { sidebar: { ...useRuntime.getState().tabs.t.sidebar!, locals: [branch('feature/login')] } });
    renderIt();
    const ev = fireEvent.contextMenu(within(panel('Local')).getByRole('treeitem', { name: 'feature' }));
    expect(ev).toBe(false); // the native menu is still suppressed
    expect(rowsOpen()).toBeNull();
  });

  it('the ContextMenu key and Shift+F10 open the active row\'s menu', () => {
    renderIt();
    const tree = within(panel('Local')).getByRole('tree');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ContextMenu' });
    expect(rowsOpen()).toContain('Copy SHA');
    act(() => useMenu.getState().close());
    fireEvent.keyDown(tree, { key: 'F10', shiftKey: true });
    expect(rowsOpen()).toContain('Show in graph');
    act(() => useMenu.getState().close());
    fireEvent.keyDown(tree, { key: 'F10' });
    expect(rowsOpen()).toBeNull();
  });
});
