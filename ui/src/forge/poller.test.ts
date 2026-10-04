import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAST_POLL_MS, nextPollDelay } from './poller';

describe('nextPollDelay (spec #4 §3.4)', () => {
  it('follows the fetch interval, about 20 s while a pipeline runs', () => {
    expect(nextPollDelay(60_000, null)).toBe(60_000);
    expect(nextPollDelay(60_000, { runningPipeline: false, serverIntervalMs: null })).toBe(60_000);
    expect(nextPollDelay(60_000, { runningPipeline: true, serverIntervalMs: null })).toBe(FAST_POLL_MS);
    // Never slower than the timer.
    expect(nextPollDelay(10_000, { runningPipeline: true, serverIntervalMs: null })).toBe(10_000);
  });

  it("never polls faster than the server's Poll-Interval", () => {
    expect(nextPollDelay(60_000, { runningPipeline: true, serverIntervalMs: 30_000 })).toBe(30_000);
    expect(nextPollDelay(60_000, { runningPipeline: false, serverIntervalMs: 120_000 })).toBe(120_000);
  });

  it('is off (no timed polls at all) when the fetch interval is off', () => {
    expect(nextPollDelay(0, { runningPipeline: true, serverIntervalMs: null })).toBeNull();
    expect(nextPollDelay(-1, null)).toBeNull();
  });
});

// --- 4B T7 ---
import { backoffMs, createForgePoller, FOCUS_GAP_MS, MAX_BACKOFF_MS, type PollOutcome, type PollReason } from './poller';

function harness(outcome: PollOutcome = { runningPipeline: false, serverIntervalMs: null }, minimized = false) {
  const reasons: PollReason[] = [];
  const state = { outcome, minimized };
  const deps = {
    now: () => Date.now(),
    isMinimized: vi.fn(async () => state.minimized),
    poll: vi.fn(async (r: PollReason) => {
      reasons.push(r);
      return state.outcome;
    }),
  };
  return { reasons, state, deps };
}

describe('createForgePoller (spec #4 §3.4)', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('polls at once when started, then on the fetch interval', async () => {
    const h = harness();
    const p = createForgePoller(60_000, h.deps);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reasons).toEqual(['activate']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reasons).toEqual(['activate', 'timer']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.reasons).toEqual(['activate', 'timer', 'timer', 'timer']);
    p.stop();
  });

  it('polls fast every 20 s while a pipeline runs, and fully once the fetch interval has passed', async () => {
    const h = harness({ runningPipeline: true, serverIntervalMs: null });
    const p = createForgePoller(60_000, h.deps);
    p.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reasons).toEqual(['activate', 'fast', 'fast', 'timer']);
    h.state.outcome = { runningPipeline: false, serverIntervalMs: null };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.reasons.at(-1)).toBe('fast');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.reasons).toHaveLength(5);
    p.stop();
  });

  it("waits at least the server's interval (and the backoff it carries)", async () => {
    const h = harness({ runningPipeline: true, serverIntervalMs: 45_000 });
    const p = createForgePoller(60_000, h.deps);
    p.start();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(h.reasons).toEqual(['activate']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reasons).toEqual(['activate', 'fast']);
    p.stop();
  });

  it('a stopped poller never polls, even when a running poll ends', async () => {
    const h = harness();
    let release: (o: PollOutcome) => void = () => {};
    h.deps.poll.mockImplementationOnce((r: PollReason) => { h.reasons.push(r); return new Promise<PollOutcome>((res) => { release = res; }); });
    const p = createForgePoller(60_000, h.deps);
    p.start();
    p.stop();
    release({ runningPipeline: true, serverIntervalMs: null });
    p.onFocus(true);
    p.afterWrite();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.reasons).toEqual(['activate']);
  });

  it('a write polls at once; one that arrives during a poll runs right after it', async () => {
    const h = harness();
    let release: (o: PollOutcome) => void = () => {};
    h.deps.poll.mockImplementationOnce((r: PollReason) => { h.reasons.push(r); return new Promise<PollOutcome>((res) => { release = res; }); });
    const p = createForgePoller(60_000, h.deps);
    p.start();
    p.afterWrite();
    p.afterWrite();
    expect(h.reasons).toEqual(['activate']);
    release({ runningPipeline: false, serverIntervalMs: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reasons).toEqual(['activate', 'write']);
    p.stop();
  });

  it('focus polls unless a full poll just ran; a tick skipped while minimized is made up on focus', async () => {
    const h = harness();
    const p = createForgePoller(60_000, h.deps);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.onFocus(true);
    expect(h.reasons).toEqual(['activate']);
    await vi.advanceTimersByTimeAsync(FOCUS_GAP_MS);
    p.onFocus(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reasons).toEqual(['activate', 'focus']);
    h.state.minimized = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reasons).toEqual(['activate', 'focus']);
    p.onFocus(false);
    p.onFocus(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reasons).toEqual(['activate', 'focus', 'focus']);
    p.stop();
  });

  it('with the fetch interval off, only activation, focus and writes poll', async () => {
    const h = harness({ runningPipeline: true, serverIntervalMs: null });
    const p = createForgePoller(0, h.deps);
    p.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.reasons).toEqual(['activate']);
    p.afterWrite();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reasons).toEqual(['activate', 'write']);
    p.stop();
  });
});

describe('backoffMs (spec #4 §6: the poller backs off)', () => {
  it('backs off after failures, at most 15 minutes', () => {
    expect(backoffMs(60_000, 0)).toBe(0);
    expect(backoffMs(60_000, 1)).toBe(60_000);
    expect(backoffMs(60_000, 3)).toBe(240_000);
    expect(backoffMs(10_000, 1)).toBe(60_000);
    expect(backoffMs(300_000, 10)).toBe(MAX_BACKOFF_MS);
  });
});
describe('createForgePoller failures and restarts', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('backs off after a rejected poll, and a success resets it', async () => {
    const h = harness();
    h.deps.poll.mockImplementationOnce(async (r: PollReason) => { h.reasons.push(r); throw new Error('x'); });
    const p = createForgePoller(10_000, h.deps);
    p.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.reasons).toEqual(['activate']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reasons).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.reasons).toHaveLength(3);
    p.stop();
  });

  it('a stale poll resolving after stop and start does nothing', async () => {
    const h = harness();
    let release: (o: PollOutcome) => void = () => {};
    h.deps.poll.mockImplementationOnce((r: PollReason) => { h.reasons.push(r); return new Promise<PollOutcome>((res) => { release = res; }); });
    const p = createForgePoller(60_000, h.deps);
    p.start();
    p.stop();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reasons).toEqual(['activate', 'activate']);
    release({ runningPipeline: true, serverIntervalMs: 1_000_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reasons).toEqual(['activate', 'activate', 'timer']);
    p.stop();
  });
});
// --- end 4B T7 ---
