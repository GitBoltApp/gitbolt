import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  cancelOp: vi.fn(async () => null),
  queueState: vi.fn(async () => ({ running: null, queued: [], stopped: null })),
  appInfo: vi.fn(async () => ({ appVersion: '0.1.0', gitVersion: '2.47.1' })),
}));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { StatusBar, SLOW_FETCH_MS, SLOW_STASH_MS } = await import('./StatusBar');
const { useOps } = await import('../app/ops');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { useMenu } = await import('../menu/menuStore');
const { setZoom, useZoom } = await import('../ui/zoom');

const bar = () => screen.getByRole('contentinfo');

describe('StatusBar (spec §6.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOps.setState({ ops: {}, prompts: [], errors: [], unread: 0, activity: [] });
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

  it('never shows a background fetch, nor a quick fetch of the user\'s (K30)', () => {
    vi.useFakeTimers();
    try {
      render(<StatusBar />);
      const before = bar().textContent;
      act(() => useOps.getState().apply({ type: 'opStarted', op: 4, kind: 'fetch', repo: 1, label: 'gitbolt', interactive: false }));
      act(() => useOps.getState().apply({ type: 'opProgress', op: 4, phase: 'Receiving objects', percent: 40 }));
      act(() => vi.advanceTimersByTime(SLOW_FETCH_MS * 3));
      expect(bar().textContent).toBe(before);
      act(() => useOps.getState().apply({ type: 'opStarted', op: 5, kind: 'fetch', repo: 1, label: 'gitbolt', interactive: true }));
      act(() => vi.advanceTimersByTime(SLOW_FETCH_MS - 100));
      expect(bar().textContent).toBe(before);
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      act(() => useOps.getState().apply({ type: 'opFinished', op: 4, kind: 'fetch', repo: 1, outcome: 'ok', message: null, command: null }));
      act(() => useOps.getState().apply({ type: 'opFinished', op: 5, kind: 'fetch', repo: 1, outcome: 'ok', message: null, command: null }));
      act(() => vi.advanceTimersByTime(SLOW_FETCH_MS));
      expect(bar().textContent).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow fetch of the user\'s shows its progress, with Cancel (K96: a stuck one can be stopped)', () => {
    vi.useFakeTimers();
    try {
      render(<StatusBar />);
      act(() => useOps.getState().apply({ type: 'opStarted', op: 6, kind: 'fetch', repo: 1, label: 'shop', interactive: true }));
      act(() => vi.advanceTimersByTime(SLOW_FETCH_MS));
      expect(bar()).toHaveTextContent('Fetching shop…');
      act(() => useOps.getState().apply({ type: 'opProgress', op: 6, phase: 'Receiving objects', percent: 45 }));
      expect(bar()).toHaveTextContent('Fetching shop… 45%');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(api.cancelOp).toHaveBeenCalledWith(6);
      act(() => useOps.getState().apply({ type: 'opFinished', op: 6, kind: 'fetch', repo: 1, outcome: 'cancelled', message: 'Cancelled', command: null }));
      expect(bar()).not.toHaveTextContent('Fetching');
    } finally {
      vi.useRealTimers();
    }
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
    const labels = () => useMenu.getState().rows!.map((r) => (r.kind === 'separator' ? '-' : r.label));
    fireEvent.click(bell());
    expect(labels()).toEqual(['No notifications', '-', 'Activity log…']);
    act(() => useMenu.getState().close());
    act(() => { useOps.getState().pushError('Fetch failed (a): one'); useOps.getState().pushError('Fetch failed (b): two'); });
    expect(bell()).toHaveAccessibleName('Notifications (2 new)');
    fireEvent.click(bell());
    expect(labels()).toEqual(['Fetch failed (b): two', 'Fetch failed (a): one', '-', 'Activity log…', 'Clear notifications']);
    expect(bell()).toHaveAccessibleName('Notifications');
  });

  it('shows a write still running after 2 s, with Cancel (spec #2 §3.3)', async () => {
    vi.useFakeTimers();
    try {
      render(<StatusBar />);
      act(() => useOps.getState().apply({ type: 'opStarted', op: 7, kind: 'commit', repo: 1, label: 'commit "Fix x"', interactive: true }));
      expect(screen.queryByText(/Committing…/)).toBeNull();
      act(() => { vi.advanceTimersByTime(SLOW_FETCH_MS); });
      expect(screen.getByText(/Committing…/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(api.cancelOp).toHaveBeenCalledWith(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow autostash step says so, and its Stop leaves the changes in the stash (spec #2 §6)', async () => {
    vi.useFakeTimers();
    try {
      render(<StatusBar />);
      act(() => useOps.getState().apply({ type: 'opStarted', op: 8, kind: 'checkout', repo: 1, label: 'checkout side', interactive: true }));
      act(() => useOps.getState().apply({ type: 'opStashStep', op: 8, step: 'saving', message: 'autostash before checkout side' }));
      act(() => { vi.advanceTimersByTime(SLOW_FETCH_MS); });
      expect(screen.getByText(/Checkout side…/)).toBeInTheDocument();
      const stop = screen.getByRole('button', { name: 'Stop — your changes stay in stash autostash before checkout side' });
      act(() => { vi.advanceTimersByTime(SLOW_STASH_MS); });
      expect(screen.getByText(/Saving your changes…/)).toBeInTheDocument();
      fireEvent.click(stop);
      expect(api.cancelOp).toHaveBeenCalledWith(8);
      // The restore is its own step: its minute starts again.
      act(() => useOps.getState().apply({ type: 'opStashStep', op: 8, step: null, message: 'autostash before checkout side' }));
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      act(() => useOps.getState().apply({ type: 'opStashStep', op: 8, step: 'restoring', message: 'autostash before checkout side' }));
      expect(screen.getByText(/Checkout side…/)).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(SLOW_STASH_MS); });
      expect(screen.getByText(/Restoring your changes…/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
