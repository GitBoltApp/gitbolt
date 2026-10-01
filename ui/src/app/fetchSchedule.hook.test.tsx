import { act, render } from '@testing-library/react';
import { Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../api/client', () => ({
  api,
  errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)),
  onEvent: () => () => {},
}));
const platform = vi.hoisted(() => ({ isMinimized: vi.fn(async () => false), onFocusChanged: vi.fn(() => () => {}) }));
vi.mock('./platform', () => ({ platform }));

const { runFetch, useFetchScheduler } = await import('./fetchSchedule');
const { useRuntime } = await import('./runtime');
const { useAppState, DEFAULT_SETTINGS } = await import('./state');
const { useOps } = await import('./ops');
const { useToast } = await import('../ui/toast');

const repo = { id: 4, path: '/r', name: 'r' };
const rt = () => useRuntime.getState().tabs.t!;

beforeEach(() => {
  vi.clearAllMocks();
  useRuntime.setState({ tabs: {} });
  useRuntime.getState().patch('t', { repo, status: 'ready' });
  useOps.setState({ ops: {}, prompts: [], errors: [], unread: 0 });
  useToast.setState({ message: null });
  useAppState.setState({ settings: { ...DEFAULT_SETTINGS, fetchIntervalSecs: 60 } });
});

describe('runFetch', () => {
  it('a done fetch records the time and clears an earlier skip', async () => {
    useRuntime.getState().patch('t', { fetchSkipped: 'x' });
    api.fetch.mockResolvedValue({ status: 'done', changed: true });
    await runFetch('t', false);
    expect(api.fetch).toHaveBeenCalledWith(4, false);
    expect(rt().lastFetchAt).toBeGreaterThan(0);
    expect(rt().fetchSkipped).toBeNull();
  });

  it('a background fetch skipped for credentials shows as skipped, and never prompts or toasts', async () => {
    api.fetch.mockResolvedValue({ status: 'skipped', reason: 'authRequired' });
    await runFetch('t', true);
    expect(api.fetch).toHaveBeenCalledWith(4, true);
    expect(rt().fetchSkipped).toBe('Fetch skipped: authentication required');
    expect(useToast.getState().message).toBeNull();
    expect(useOps.getState().prompts).toEqual([]);
  });

  it('background errors go to the bell, user errors to a toast; a cancel is quiet', async () => {
    api.fetch.mockRejectedValueOnce({ kind: 'Other', message: 'boom' });
    await runFetch('t', true);
    expect(useOps.getState().errors[0].message).toBe('Fetch failed (r): boom');
    expect(useToast.getState().message).toBeNull();
    api.fetch.mockRejectedValueOnce({ kind: 'AuthFailed', message: 'remote: authentication required' });
    await runFetch('t', false);
    expect(useToast.getState().message).toBe('Fetch failed: Authentication failed (remote: authentication required)');
    useToast.setState({ message: null });
    api.fetch.mockRejectedValueOnce({ kind: 'Cancelled', message: 'Cancelled' });
    await runFetch('t', false);
    expect(useToast.getState().message).toBeNull();
    expect(useOps.getState().errors).toHaveLength(1);
  });

  it('a user fetch while one runs says so; a background one stays quiet', async () => {
    api.fetch.mockResolvedValue({ status: 'skipped', reason: 'busy' });
    await runFetch('t', true);
    expect(useToast.getState().message).toBeNull();
    await runFetch('t', false);
    expect(useToast.getState().message).toBe('A fetch is already running');
  });
});

function Scheduled({ repoId }: { repoId?: number }) {
  useFetchScheduler('t', repoId);
  return null;
}

describe('useFetchScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.fetch.mockResolvedValue({ status: 'done', changed: false });
  });
  afterEach(() => vi.useRealTimers());

  it('runs only while its tab is visible: a hidden <Activity> has no timer (spec §4.4)', async () => {
    const { rerender } = render(<Activity mode="visible"><Scheduled repoId={4} /></Activity>);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(api.fetch).toHaveBeenLastCalledWith(4, true);
    expect(platform.onFocusChanged).toHaveBeenCalledTimes(1);
    rerender(<Activity mode="hidden"><Scheduled repoId={4} /></Activity>);
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(platform.isMinimized).toHaveBeenCalledTimes(1);
    // Shown again: the last fetch is 10 minutes old, so one fetch at once, then the timer runs.
    rerender(<Activity mode="visible"><Scheduled repoId={4} /></Activity>);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.fetch).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(api.fetch).toHaveBeenCalledTimes(3);
  });

  it('does nothing without a repo, or with the interval off', async () => {
    const { rerender } = render(<Scheduled />);
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(api.fetch).not.toHaveBeenCalled();
    act(() => useAppState.setState({ settings: { ...DEFAULT_SETTINGS, fetchIntervalSecs: 0 } }));
    rerender(<Scheduled repoId={4} />);
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(api.fetch).not.toHaveBeenCalled();
  });
});
