import { act, fireEvent, render, screen } from '@testing-library/react';
import { Search } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBranch } from '../api/gen/LocalBranch';

const api = vi.hoisted(() => ({ fetch: vi.fn(async () => ({ status: 'done', changed: false })) }));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
const checkoutLocal = vi.hoisted(() => vi.fn());
vi.mock('../branches/checkout', () => ({ checkoutLocal }));

await import('./feature');
const { Toolbar } = await import('./Toolbar');
const { registerToolbarButton } = await import('./registry');
const { registerActions } = await import('../app/actions');
const { RepoContext } = await import('../app/repoContext');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { useOps } = await import('../app/ops');
const useQueueModule = await import('../queue/store');
const { useMenu } = await import('../menu/menuStore');
const { useToast } = await import('../ui/toast');

const branch = (name: string, target: string, over: Partial<LocalBranch> = {}): LocalBranch => ({
  name, fullName: `refs/heads/${name}`, target, upstream: null, ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '', isHead: false, worktree: null, checkedOut: null, pushTarget: null, pushBehind: null, rewritten: null, ...over,
});

const ctx = { tabId: 't', repoId: 4, path: '/r', worktree: '/r', info: null };
const renderToolbar = () => render(<RepoContext value={ctx}><Toolbar /></RepoContext>);

describe('Toolbar (spec §6.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOps.setState({ ops: {}, prompts: [], errors: [], unread: 0 });
    useMenu.getState().close();
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
    useRuntime.setState({ tabs: {} });
    useRuntime.getState().patch('t', {
      status: 'ready',
      repo: { id: 4, path: '/r', name: 'gitbolt', worktree: '/r' },
      graph: { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: 'refs/heads/main', target: 'aaaaaaaaaa', detached: false, unborn: false }, truncated: false, worktrees: [] },
      sidebar: { locals: [branch('main', 'aaaaaaaaaa', { isHead: true }), branch('feature/login', 'bbbbbbbbbb', { ahead: 2, behind: 1 })], remotes: [], worktrees: [], stashes: [], tags: [] },
    });
  });

  it('shows the repository and its current branch', () => {
    renderToolbar();
    expect(screen.getByRole('toolbar', { name: 'Repository toolbar' })).toHaveTextContent('gitbolt');
    expect(screen.getByRole('button', { name: 'Branch: main' })).toBeInTheDocument();
  });

  it('Fetch runs the default (Fetch All: a user fetch), and its caret opens the default picker', async () => {
    renderToolbar();
    useToast.getState().dismiss();
    api.fetch.mockResolvedValueOnce({ status: 'done', changed: true, op: 1, server: { lines: 0, warning: null } } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
    expect(api.fetch).toHaveBeenCalledWith(4, false);
    await act(async () => { await Promise.resolve(); });
    expect(useToast.getState().message).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fetch options' }));
    expect(screen.getByRole('menu', { name: 'Select a default pull/fetch operation to execute when clicking this button' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['Fetch All', 'Pull (fast-forward if possible)', 'Pull (fast-forward only)', 'Pull (rebase)']);
    expect(screen.getByRole('menuitemradio', { name: 'Fetch All' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Pull (rebase)' }));
    expect(useAppState.getState().settings.syncButton).toBe('pullRebase');
    expect(api.fetch).toHaveBeenCalledTimes(1);
    useAppState.getState().setSettings({ syncButton: 'fetchAll' });
  });

  it('Fetch is busy while the user\'s fetch runs for this repo, not another repo', () => {
    renderToolbar();
    act(() => useOps.getState().apply({ type: 'opStarted', op: 1, kind: 'fetch', repo: 9, label: 'other', interactive: true }));
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeEnabled();
    act(() => useOps.getState().apply({ type: 'opStarted', op: 2, kind: 'fetch', repo: 4, label: 'gitbolt', interactive: true }));
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fetch' })).toHaveAttribute('aria-busy', 'true');
  });

  it('a background fetch leaves Fetch alone, until a user\'s Fetch waits on it (K30)', () => {
    renderToolbar();
    act(() => useOps.getState().apply({ type: 'opStarted', op: 3, kind: 'fetch', repo: 4, label: 'gitbolt', interactive: false }));
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Fetch' })).not.toHaveAttribute('aria-busy');
    act(() => useOps.getState().showOp(3));
    expect(screen.getByRole('button', { name: 'Fetch' })).toHaveAttribute('aria-busy', 'true');
    act(() => useOps.getState().apply({ type: 'opFinished', op: 3, kind: 'fetch', repo: 4, outcome: 'ok', message: null, command: null }));
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeEnabled();
  });

  it('renders buttons from registered action ids, and none for an action that does not exist', () => {
    const run = vi.fn();
    const offA = registerActions([{ id: 'test.search', label: 'Find commits', group: 'Edit', icon: Search, tooltip: 'Find in the graph', shortcuts: ['Ctrl+F'], run }]);
    const offB = registerToolbarButton({ action: 'test.search', label: 'Search', order: 30 });
    const offC = registerToolbarButton({ action: 'test.missing', label: 'Ghost', order: 40 });
    renderToolbar();
    expect(screen.queryByRole('button', { name: 'Ghost' })).toBeNull();
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(buttons.indexOf('Search')).toBeGreaterThan(buttons.indexOf('Fetch'));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(run).toHaveBeenCalledTimes(1);
    offA(); offB(); offC();
  });

  it('end-placed buttons sit after the second spacer, centre ones before it, in DOM order', () => {
    const run = vi.fn();
    const offA = registerActions([{ id: 'test.end', label: 'End thing', group: 'Edit', icon: Search, tooltip: 'x', run }, { id: 'test.mid', label: 'Mid thing', group: 'Edit', icon: Search, tooltip: 'y', run }]);
    const offB = registerToolbarButton({ action: 'test.end', label: 'EndBtn', placement: 'end', order: 1 });
    const offC = registerToolbarButton({ action: 'test.mid', label: 'MidBtn', order: 99 });
    const { container } = renderToolbar();
    const kids = [...container.querySelector('.toolbar')!.children];
    const spacers = kids.filter((k) => k.classList.contains('tb-spacer'));
    expect(spacers).toHaveLength(2);
    const at = (name: string) => kids.findIndex((k) => k.querySelector(`[aria-label="${name}"]`) || k.getAttribute('aria-label') === name);
    expect(at('Fetch')).toBeLessThan(at('MidBtn'));
    expect(at('MidBtn')).toBeLessThan(kids.indexOf(spacers[1]));
    expect(at('EndBtn')).toBeGreaterThan(kids.indexOf(spacers[1]));
    expect(kids.indexOf(spacers[1]) + 1).toBe(at('EndBtn'));
    offA(); offB(); offC();
  });

  it('Search appears once find registers edit.find, and runs it', () => {
    const first = renderToolbar();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    first.unmount();
    const run = vi.fn();
    const off = registerActions([{ id: 'edit.find', label: 'Find', group: 'Edit', icon: Search, tooltip: 'Find commits', shortcuts: ['Ctrl+F'], run }]);
    renderToolbar();
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names.indexOf('Search')).toBe(names.indexOf('Fetch options') + 1);
    const kids = [...document.querySelector('.toolbar')!.children];
    expect(kids.at(-1)!.getAttribute('aria-label')).toBe('Search');
    expect(kids.at(-2)!.classList.contains('tb-spacer')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(run).toHaveBeenCalledTimes(1);
    off();
  });

  it('a button\'s action registered after the toolbar mounted still appears, and goes when released', () => {
    renderToolbar();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    let off: () => void = () => {};
    act(() => { off = registerActions([{ id: 'edit.find', label: 'Find', group: 'Edit', icon: Search, tooltip: 'Find commits', run: vi.fn() }]); });
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    act(() => off());
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
  });

  it('the branch picker lists the local branches and checks out the picked one', () => {
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Branch: main' }));
    const options = screen.getAllByRole('option');
    // Alphabetical by default (K72).
    expect(options.map((o) => o.textContent)).toEqual(['feature/login2↑ 1↓', 'main']);
    fireEvent.click(screen.getByText('feature/login'));
    expect(checkoutLocal).toHaveBeenCalledWith('t', 'feature/login');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows a queued badge on a button whose op waits in the queue (spec #2 §3.6)', () => {
    const { useQueue } = useQueueModule;
    act(() => useQueue.getState().set(4, { running: { id: 1, label: 'commit', kind: 'commit', op: 9 }, queued: [{ id: 2, label: 'fetch r', kind: 'fetch', op: 10 }], stopped: null }));
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Fetch' }).querySelector('.tb-queued')).not.toBeNull();
    act(() => useQueue.getState().set(4, { running: null, queued: [], stopped: null }));
    expect(screen.getByRole('button', { name: 'Fetch' }).querySelector('.tb-queued')).toBeNull();
  });

  it('a button\'s view can disable it with a reason, keeping its tooltip reachable', async () => {
    const run = vi.fn();
    const offA = registerActions([{ id: 't.view', label: 'Undo', group: 'Edit', icon: Search, tooltip: 'Undo', run }]);
    const offB = registerToolbarButton({ action: 't.view', order: 99, useView: () => ({ tooltip: 'Nothing to undo', disabled: true }) });
    renderToolbar();
    const b = screen.getByRole('button', { name: 'Undo' });
    expect(b).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(b);
    expect(run).not.toHaveBeenCalled();
    fireEvent.mouseEnter(b);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Nothing to undo');
    offA();
    offB();
  });

  it('a picker button\'s caret opens its picker; menuRows build the caret\'s rows when it opens; a view sets the caption', async () => {
    const run = vi.fn();
    const offA = registerActions([{ id: 't.sync', label: 'Fetch', group: 'Repository', icon: Search, tooltip: 'Fetch every remote', run }, { id: 't.push', label: 'Push', group: 'Repository', icon: Search, tooltip: 'Push', run }]);
    let mode = 'fetchAll';
    const offB = registerToolbarButton({ action: 't.sync', order: 98, picker: { title: 'Pick one', options: [{ value: 'fetchAll', label: 'Fetch All' }, { value: 'pullFfOnly', label: 'Pull (fast-forward only)' }], useValue: () => mode, set: (v) => { mode = v; } }, useView: () => ({ tooltip: 'Pull origin/main into main (fast-forward only)', disabled: false, label: 'Pull' }) });
    const rows = vi.fn(() => [{ kind: 'action' as const, id: 'up', label: 'origin/main', icon: Search, tooltip: 'Track origin/main', run }]);
    const offC = registerToolbarButton({ action: 't.push', order: 99, menuRows: rows });
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Pull' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pull options' }));
    expect(await screen.findByText('Pick one')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Pull (fast-forward only)' }));
    expect(mode).toBe('pullFfOnly');
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Push options' }));
    expect(rows).toHaveBeenCalled();
    offA();
    offB();
    offC();
  });
});
