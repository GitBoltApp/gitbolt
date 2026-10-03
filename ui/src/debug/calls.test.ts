import { describe, expect, it, vi } from 'vitest';
import { timed, type Transport } from '../api/transport';
import { CALL_CAPACITY, DEBUG_METHODS, recentCalls, recordCall, subscribeCalls } from './calls';

describe('backend call timings (T9)', () => {
  it(`keeps the last ${CALL_CAPACITY} calls and notifies subscribers`, () => {
    const l = vi.fn();
    const off = subscribeCalls(l);
    for (let i = 0; i < CALL_CAPACITY + 3; i++) recordCall({ method: `m${i}`, ms: i, ok: true, at: i });
    expect(recentCalls()).toHaveLength(CALL_CAPACITY);
    expect(recentCalls()[0].method).toBe('m3');
    expect(l).toHaveBeenCalledTimes(CALL_CAPACITY + 3);
    const snapshot = recentCalls();
    expect(recentCalls()).toBe(snapshot); // stable between changes (useSyncExternalStore)
    off();
    recordCall({ method: 'x', ms: 1, ok: false, at: 0 });
    expect(l).toHaveBeenCalledTimes(CALL_CAPACITY + 3);
  });

  it("leaves out the Debug tools' own calls, without notifying", () => {
    const l = vi.fn();
    const off = subscribeCalls(l);
    const before = recentCalls();
    for (const method of DEBUG_METHODS) recordCall({ method, ms: 1, ok: true, at: 0 });
    expect(recentCalls()).toBe(before);
    expect(l).not.toHaveBeenCalled();
    off();
  });

  it('the transport times every call, ok or failed', async () => {
    const inner: Transport = {
      call: (req) => (req.method === 'graph' ? Promise.resolve([]) : Promise.reject({ kind: 'Io', message: 'x' })),
      subscribe: () => () => {},
    };
    const t = timed(inner);
    await t.call({ method: 'graph', params: { repo: 1, limit: null } });
    await expect(t.call({ method: 'remotes', params: { repo: 1 } })).rejects.toMatchObject({ kind: 'Io' });
    const [a, b] = recentCalls().slice(-2);
    expect(a).toMatchObject({ method: 'graph', ok: true });
    expect(b).toMatchObject({ method: 'remotes', ok: false });
    expect(a.ms).toBeGreaterThanOrEqual(0);
  });
});
