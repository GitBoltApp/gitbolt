import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAST_POLL_MAX_MS, FAST_POLL_MS, fastPollMs, MIN_POLL_MS, nextPollDelay } from './poller';

describe('nextPollDelay (spec #4 §3.4)', () => {
  it('follows the fetch interval, never under a minute, and the fast poll while a pipeline runs', () => {
    expect(nextPollDelay(60_000, null)).toBe(60_000);
    expect(nextPollDelay(60_000, { runningPipeline: false, serverIntervalMs: null })).toBe(60_000);
    expect(nextPollDelay(10_000, { runningPipeline: false, serverIntervalMs: null })).toBe(MIN_POLL_MS);
    expect(nextPollDelay(60_000, { runningPipeline: true, serverIntervalMs: null })).toBe(FAST_POLL_MS);
    // Never slower than the timer.
    expect(nextPollDelay(60_000, { runningPipeline: true, serverIntervalMs: null }, 3)).toBe(60_000);
    expect(nextPollDelay(600_000, { runningPipeline: true, serverIntervalMs: null }, 3)).toBe(FAST_POLL_MAX_MS);
  });

  it('the fast poll grows 20 s, 40 s, 80 s, then 2 min', () => {
    expect([0, 1, 2, 3, 4].map(fastPollMs)).toEqual([20_000, 40_000, 80_000, 120_000, 120_000]);
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
  const state = { outcome, minimized, focused: true, random: 0 };
  const deps = {
    now: () => Date.now(),
    isMinimized: vi.fn(async () => state.minimized),
    isFocused: vi.fn(async () => state.focused),
    random: () => state.random,
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

  it('polls fast while a pipeline runs, waiting longer while the same one keeps running, and fully once the fetch interval has passed', async () => {
    const h = harness({ runningPipeline: true, serverIntervalMs: null, pipelineKey: '5:abc' });
    const p = createForgePoller(300_000, h.deps);
    p.start();
    const at: number[] = [];
    h.deps.poll.mockImplementation(async (r: PollReason) => { h.reasons.push(r); at.push(Date.now() - 1_000_000); return h.state.outcome; });
    await vi.advanceTimersByTimeAsync(380_000);
    // 20 s, 40 s, 80 s, then 2 min apart; the fetch interval (5 min) makes the last one full.
    expect(h.reasons).toEqual(['activate', 'fast', 'fast', 'fast', 'fast', 'timer']);
    expect(at).toEqual([20_000, 60_000, 140_000, 260_000, 380_000]);
    // Another pipeline starts: back to 20 s.
    h.state.outcome = { runningPipeline: true, serverIntervalMs: null, pipelineKey: '5:def' };
    await vi.advanceTimersByTimeAsync(120_000);
    h.state.outcome = { runningPipeline: false, serverIntervalMs: null };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(at.slice(5)).toEqual([500_000, 520_000]);
    // Nothing runs: the fetch interval again.
    await vi.advanceTimersByTimeAsync(299_999);
    expect(at).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toHaveLength(8);
    p.stop();
  });

  it('polls only while the window has the focus, and once on refocus if a tick was skipped', async () => {
    const h = harness({ runningPipeline: true, serverIntervalMs: null, pipelineKey: '1:a' });
    h.state.focused = false;
    const p = createForgePoller(60_000, h.deps);
    p.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.reasons).toEqual(['activate']);
    p.onFocus(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reasons).toEqual(['activate', 'focus']);
    // The same pipeline as before the focus left: 40 s.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.reasons).toEqual(['activate', 'focus', 'fast']);
    p.onFocus(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.reasons).toHaveLength(3);
    p.stop();
  });

  it('a failure backoff gets some jitter', async () => {
    const h = harness();
    h.state.random = 0.5;
    h.deps.poll.mockImplementationOnce(async (r: PollReason) => { h.reasons.push(r); throw new Error('x'); });
    const p = createForgePoller(60_000, h.deps);
    p.start();
    await vi.advanceTimersByTimeAsync(65_999);
    expect(h.reasons).toEqual(['activate']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reasons).toEqual(['activate', 'timer']);
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
    const p = createForgePoller(120_000, h.deps);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.onFocus(true);
    await vi.advanceTimersByTimeAsync(FOCUS_GAP_MS - 1);
    p.onFocus(true);
    expect(h.reasons).toEqual(['activate']);
    await vi.advanceTimersByTimeAsync(1);
    p.onFocus(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reasons).toEqual(['activate', 'focus']);
    h.state.minimized = true;
    await vi.advanceTimersByTimeAsync(120_000);
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
    // The success: the fetch interval again, never under a minute.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.reasons).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
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
