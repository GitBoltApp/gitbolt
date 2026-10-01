import { describe, expect, it, vi } from 'vitest';
import { timed, type Transport } from '../api/transport';
import { CALL_CAPACITY, recentCalls, recordCall, subscribeCalls } from './calls';

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

  it('the transport times every call, ok or failed', async () => {
    const inner: Transport = {
      call: (req) => (req.method === 'commandLog' ? Promise.resolve([]) : Promise.reject({ kind: 'Io', message: 'x' })),
      subscribe: () => () => {},
    };
    const t = timed(inner);
    await t.call({ method: 'commandLog' });
    await expect(t.call({ method: 'logsDir' })).rejects.toMatchObject({ kind: 'Io' });
    const [a, b] = recentCalls().slice(-2);
    expect(a).toMatchObject({ method: 'commandLog', ok: true });
    expect(b).toMatchObject({ method: 'logsDir', ok: false });
    expect(a.ms).toBeGreaterThanOrEqual(0);
  });
});
