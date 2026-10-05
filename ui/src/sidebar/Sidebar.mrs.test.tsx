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
const model = vi.hoisted(() => ({ sectionsOf: vi.fn() }));
vi.mock('./model', async (importOriginal) => {
  const m = await importOriginal<typeof import('./model')>();
  model.sectionsOf.mockImplementation(m.sectionsOf);
  return { ...m, sectionsOf: model.sectionsOf };
});

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

  it('sits below the worktrees and stashes and lists the open ones: no state icon, a draft dimmed, a pipeline only when it needs a look; a click opens one', () => {
    patchForge('t', { kind: 'gitlab', list: list() });
    show();
    expect(order()).toEqual(['Local', 'Remote', 'Worktrees', 'Stashes', 'Merge requests', 'Tags']);
    const panel = screen.getByRole('region', { name: 'Merge requests' });
    expect(within(panel).getByLabelText('Merge requests count')).toHaveTextContent('2');
    const row = within(panel).getByRole('treeitem', { name: '!12 Dev work' });
    expect(row.querySelector('.mr-state-icon')).toBeNull();
    expect(row.querySelector('.mr-pipeline-icon'), 'a passed pipeline is the hover card\'s').toBeNull();
    expect(within(panel).getByRole('treeitem', { name: '!5 Explore' }).querySelector('.sb-label[data-draft]')).toBeTruthy();
    act(() => patchForge('t', { list: list([mrOf(12, { title: 'Dev work', pipeline: { status: 'failed', webUrl: null } })]) }));
    expect(within(panel).getByRole('img', { name: 'Pipeline failed' }).querySelector('.mr-pipeline-icon[data-status="failed"]')).toBeTruthy();
    act(() => patchForge('t', { list: list() }));
    fireEvent.click(within(panel).getByRole('treeitem', { name: '!12 Dev work' }));
    expect(poll.openMrView).toHaveBeenCalledWith('t', 12);
    fireEvent.keyDown(within(panel).getByRole('tree'), { key: 'ArrowDown' });
    fireEvent.keyDown(within(panel).getByRole('tree'), { key: 'Enter' });
    expect(poll.openMrView).toHaveBeenLastCalledWith('t', 5);
  });

  describe('selection and arrow keys', () => {
    const open = () => {
      patchForge('t', { kind: 'gitlab', list: list([mrOf(12, { title: 'Dev work' }), mrOf(5, { title: 'Explore' }), mrOf(3, { title: 'Third' })]) });
      show();
      const panel = screen.getByRole('region', { name: 'Merge requests' });
      return { panel, tree: within(panel).getByRole('tree'), row: (n: string) => within(panel).getByRole('treeitem', { name: n }) };
    };

    it('a click selects the row and focuses the tree', () => {
      const { tree, row } = open();
      fireEvent.click(row('!5 Explore'));
      expect(poll.openMrView).toHaveBeenCalledWith('t', 5);
      act(() => patchForge('t', { openMr: 5 }));
      expect(row('!5 Explore')).toHaveAttribute('aria-selected', 'true');
      expect(row('!12 Dev work')).toHaveAttribute('aria-selected', 'false');
      expect(document.activeElement).toBe(tree);
    });

    it('Down / Up move the selection, opening each view; Home and End go to the ends', () => {
      const { tree } = open();
      fireEvent.keyDown(tree, { key: 'ArrowDown' });
      expect(poll.openMrView).toHaveBeenLastCalledWith('t', 5);
      fireEvent.keyDown(tree, { key: 'ArrowDown' });
      expect(poll.openMrView).toHaveBeenLastCalledWith('t', 3);
      fireEvent.keyDown(tree, { key: 'ArrowUp' });
      expect(poll.openMrView).toHaveBeenLastCalledWith('t', 5);
      fireEvent.keyDown(tree, { key: 'End' });
      expect(poll.openMrView).toHaveBeenLastCalledWith('t', 3);
      fireEvent.keyDown(tree, { key: 'Home' });
      expect(poll.openMrView).toHaveBeenLastCalledWith('t', 12);
    });

    it('closing the view clears the selection; opening one from elsewhere selects its row', () => {
      const { row } = open();
      act(() => patchForge('t', { openMr: 3 }));
      expect(row('!3 Third')).toHaveAttribute('aria-selected', 'true');
      act(() => patchForge('t', { openMr: null }));
      expect(row('!3 Third')).toHaveAttribute('aria-selected', 'false');
    });
  });

  it('a new list rebuilds only the MR/PR section, not the repository sections', () => {
    patchForge('t', { kind: 'gitlab', list: list() });
    show();
    const built = model.sectionsOf.mock.calls.length;
    act(() => patchForge('t', { list: list([mrOf(7, { title: 'Later' })]) }));
    expect(within(screen.getByRole('region', { name: 'Merge requests' })).getByRole('treeitem', { name: '!7 Later' })).toBeTruthy();
    expect(model.sectionsOf.mock.calls.length).toBe(built);
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

  it('a row has a menu: right-click, the ContextMenu key and Shift+F10; the hover card and click stay', async () => {
    await import('../forge/mrMenu');
    patchForge('t', { kind: 'gitlab', list: list() });
    show();
    const panel = screen.getByRole('region', { name: 'Merge requests' });
    const rowsOpen = () => useMenu.getState().rows?.map((r) => (r.kind === 'separator' ? '---' : r.label)) ?? null;
    const ev = fireEvent.contextMenu(within(panel).getByRole('treeitem', { name: '!12 Dev work' }));
    expect(ev).toBe(false);
    expect(rowsOpen()?.[0]).toBe('Open merge request');
    expect(rowsOpen()).toContain('Copy link');
    act(() => useMenu.getState().close());
    const tree = within(panel).getByRole('tree');
    fireEvent.keyDown(tree, { key: 'ContextMenu' });
    expect(rowsOpen()).toContain('Show in graph');
    act(() => useMenu.getState().close());
    fireEvent.keyDown(tree, { key: 'F10', shiftKey: true });
    expect(rowsOpen()).toContain('Copy number');
    act(() => useMenu.getState().close());
    fireEvent.click(within(panel).getByRole('treeitem', { name: '!12 Dev work' }));
    expect(poll.openMrView).toHaveBeenCalledWith('t', 12);
  });

  it('warns in its header when the last poll failed, keeping the rows', () => {
    patchForge('t', { kind: 'gitlab', list: list(), error: 'boom', updatedAt: Date.now() - 60_000 });
    show();
    const panel = screen.getByRole('region', { name: 'Merge requests' });
    expect(within(panel).getByRole('img', { name: /^Couldn't refresh: boom\. Last updated/ })).toBeTruthy();
    expect(within(panel).getByRole('treeitem', { name: '!12 Dev work' })).toBeTruthy();
  });
});
