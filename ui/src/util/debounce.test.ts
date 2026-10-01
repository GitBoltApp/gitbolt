import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs once, trailing, with the latest arguments', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d(2);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('flush runs a pending call now and waits for it; cancel drops it', async () => {
    let done = false;
    const fn = vi.fn(async (_arg: string) => { await Promise.resolve(); done = true; });
    const d = debounce(fn, 100);
    await d.flush(); // nothing pending: a no-op
    expect(fn).not.toHaveBeenCalled();
    d('x');
    await d.flush();
    expect(done).toBe(true);
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    d('y');
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
