import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const afterWrite = vi.hoisted(() => vi.fn());
vi.mock('./poller', () => ({ createForgePoller: () => ({ start: vi.fn(), stop: vi.fn(), onFocus: vi.fn(), afterWrite }) }));
vi.mock('./poll', () => ({ pollForge: vi.fn() }));

const { useForgePolling, notifyBranchPushed, AFTER_PUSH_POLLS_MS } = await import('./usePolling');

describe('notifyBranchPushed: a push refreshes its MR/PR', () => {
  beforeEach(() => { vi.useFakeTimers(); afterWrite.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('polls at once, then again as the forge starts the new pipeline', () => {
    const { unmount } = renderHook(() => useForgePolling('t1', 3));
    notifyBranchPushed('t1');
    expect(afterWrite).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AFTER_PUSH_POLLS_MS[0]);
    expect(afterWrite).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(AFTER_PUSH_POLLS_MS[1] - AFTER_PUSH_POLLS_MS[0]);
    expect(afterWrite).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('a newer push restarts the follow-ups instead of stacking them', () => {
    const { unmount } = renderHook(() => useForgePolling('t1', 3));
    notifyBranchPushed('t1');
    vi.advanceTimersByTime(2_000);
    notifyBranchPushed('t1');
    vi.advanceTimersByTime(AFTER_PUSH_POLLS_MS[1]);
    expect(afterWrite).toHaveBeenCalledTimes(2 + AFTER_PUSH_POLLS_MS.length);
    unmount();
  });

  it('a tab with no poller (another tab is shown) does nothing', () => {
    notifyBranchPushed('nobody');
    vi.advanceTimersByTime(AFTER_PUSH_POLLS_MS[1]);
    expect(afterWrite).not.toHaveBeenCalled();
  });
});
