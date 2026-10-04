import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const stops = vi.hoisted(() => ({ stop: vi.fn() }));
const poll = vi.hoisted(() => ({ pollForge: vi.fn(async () => ({ runningPipeline: false, serverIntervalMs: null })) }));
vi.mock('./poll', () => poll);

const { notifyForgeWrite, useForgePolling } = await import('./usePolling');

describe('useForgePolling (spec #4 §3.4: the active tab only)', () => {
  it('polls the shown tab at once and after a write, and stops when it hides', async () => {
    const { unmount } = renderHook(() => useForgePolling('t', 4));
    await waitFor(() => expect(poll.pollForge).toHaveBeenCalledWith('t', 'activate'));
    notifyForgeWrite('t');
    await waitFor(() => expect(poll.pollForge).toHaveBeenCalledWith('t', 'write'));
    unmount();
    notifyForgeWrite('t');
    await new Promise((r) => setTimeout(r, 0));
    expect(poll.pollForge).toHaveBeenCalledTimes(2);
  });

  it('does nothing before the repo is open', async () => {
    poll.pollForge.mockClear();
    renderHook(() => useForgePolling('u', undefined));
    await new Promise((r) => setTimeout(r, 0));
    expect(poll.pollForge).not.toHaveBeenCalled();
  });
});

describe('hiding the tab', () => {
  it('stops the poller when the hook unmounts (a hidden Activity)', async () => {
    vi.resetModules();
    vi.doMock('./poller', () => ({ createForgePoller: () => ({ start: vi.fn(), stop: stops.stop, onFocus: vi.fn(), afterWrite: vi.fn() }) }));
    const { useForgePolling: use } = await import('./usePolling');
    const { unmount } = renderHook(() => use('h', 1));
    unmount();
    expect(stops.stop).toHaveBeenCalledTimes(1);
    vi.doUnmock('./poller');
  });
});
