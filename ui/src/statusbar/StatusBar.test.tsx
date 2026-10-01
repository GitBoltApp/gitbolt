import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  cancelOp: vi.fn(async () => null),
  appInfo: vi.fn(async () => ({ appVersion: '0.1.0', gitVersion: '2.47.1' })),
}));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { StatusBar } = await import('./StatusBar');
const { useOps } = await import('../app/ops');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { useMenu } = await import('../menu/menuStore');
const { setZoom, useZoom } = await import('../ui/zoom');

const bar = () => screen.getByRole('contentinfo');

describe('StatusBar (spec §6.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOps.setState({ ops: {}, prompts: [], errors: [], unread: 0 });
    useMenu.getState().close();
    useRuntime.setState({ tabs: {} });
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
    useZoom.setState({ zoom: 100 });
  });

  it('shows the zoom, and its button opens the step list, starting on the current step (spec §12.3)', async () => {
    render(<StatusBar />);
    act(() => setZoom(150));
    const zoom = screen.getByRole('button', { name: 'Zoom 150%' });
    fireEvent.click(zoom);
    const m = useMenu.getState();
    expect(m.label).toBe('Zoom');
    expect(m.initialRow).toBe('zoom.150');
    expect(m.rows!.map((r) => (r.kind === 'action' ? r.label : '-'))).toEqual(['80%', '90%', '100%', '110%', '120%', '130%', '140%', '150%', '175%', '200%', '250%', '300%']);
    const r200 = m.rows!.find((r) => r.kind === 'action' && r.id === 'zoom.200');
    act(() => { if (r200?.kind === 'action') r200.run(); });
    expect(useZoom.getState().zoom).toBe(200);
    expect(screen.getByRole('button', { name: 'Zoom 200%' })).toBeInTheDocument();
  });

  it('shows the git version', async () => {
    render(<StatusBar />);
    await waitFor(() => expect(bar()).toHaveTextContent('git 2.47.1'));
  });

  it('shows a running clone with its progress, and cancels it', () => {
    render(<StatusBar />);
    act(() => useOps.getState().apply({ type: 'opStarted', op: 3, kind: 'clone', repo: null, label: '/r/x', interactive: true }));
    act(() => useOps.getState().apply({ type: 'opProgress', op: 3, phase: 'Receiving objects', percent: 40 }));
    expect(bar()).toHaveTextContent('Cloning… 40%');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cancelOp).toHaveBeenCalledWith(3);
  });

  it('never shows a fetch, the user\'s or a background one, running or done (K30)', () => {
    render(<StatusBar />);
    const before = bar().textContent;
    act(() => useOps.getState().apply({ type: 'opStarted', op: 4, kind: 'fetch', repo: 1, label: 'gitbolt', interactive: false }));
    act(() => useOps.getState().apply({ type: 'opProgress', op: 4, phase: 'Receiving objects', percent: 40 }));
    act(() => useOps.getState().apply({ type: 'opStarted', op: 5, kind: 'fetch', repo: 1, label: 'gitbolt', interactive: true }));
    expect(bar().textContent).toBe(before);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    act(() => useOps.getState().apply({ type: 'opFinished', op: 4, kind: 'fetch', repo: 1, outcome: 'ok', message: null }));
    act(() => useOps.getState().apply({ type: 'opFinished', op: 5, kind: 'fetch', repo: 1, outcome: 'ok', message: null }));
    expect(bar().textContent).toBe(before);
  });

  it('a prompt shows "Waiting for authentication…", whose Cancel cancels the op', () => {
    render(<StatusBar />);
    act(() => useOps.getState().apply({ type: 'opStarted', op: 4, kind: 'fetch', repo: 1, label: 'gitbolt', interactive: true }));
    act(() => useOps.getState().apply({ type: 'authWaiting', prompt: 2, op: 4, repo: 1, text: 'Username: ', secret: false }));
    expect(bar()).toHaveTextContent('Waiting for authentication…');
    expect(bar()).not.toHaveTextContent('Fetching…');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cancelOp).toHaveBeenCalledWith(4);
  });

  it('warns that the active tab\'s background fetch was skipped', () => {
    render(<StatusBar />);
    act(() => useRuntime.getState().patch('other', { fetchSkipped: 'Fetch skipped: authentication required' }));
    expect(bar()).not.toHaveTextContent('Fetch skipped');
    act(() => useRuntime.getState().patch('t', { fetchSkipped: 'Fetch skipped: authentication required' }));
    expect(bar()).toHaveTextContent('Fetch skipped: authentication required');
  });

  it('the bell counts unread background errors, and lists them newest first', () => {
    render(<StatusBar />);
    const bell = () => screen.getByRole('button', { name: /^Notifications/ });
    fireEvent.click(bell());
    expect(useMenu.getState().rows!.map((r) => r.kind === 'action' && r.label)).toEqual(['No notifications']);
    act(() => useMenu.getState().close());
    act(() => { useOps.getState().pushError('Fetch failed (a): one'); useOps.getState().pushError('Fetch failed (b): two'); });
    expect(bell()).toHaveAccessibleName('Notifications (2 new)');
    fireEvent.click(bell());
    const labels = useMenu.getState().rows!.map((r) => (r.kind === 'action' ? r.label : '-'));
    expect(labels).toEqual(['Fetch failed (b): two', 'Fetch failed (a): one', '-', 'Clear notifications']);
    expect(bell()).toHaveAccessibleName('Notifications');
  });
});
