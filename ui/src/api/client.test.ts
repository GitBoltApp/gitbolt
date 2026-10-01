import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from './gen/AppEvent';
import type { EventHandler } from './transport';

/** Each `createTransport` call: its close callback and the subscriber it was given. */
const made = vi.hoisted(() => [] as { closed: () => void; emit: (ev: AppEvent) => void }[]);
vi.mock('./transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport')>()),
  createTransport: (onClosed: () => void) => {
    const subs = new Set<EventHandler>();
    made.push({ closed: onClosed, emit: (ev) => { for (const h of subs) h(ev); } });
    return {
      call: async () => null,
      subscribe: (h: EventHandler) => { subs.add(h); return () => { subs.delete(h); }; },
    };
  },
}));

const { onEvent, RECONNECT_MS } = await import('./client');

describe('onEvent', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('keeps receiving events after the harness socket drops and reconnects', () => {
    vi.useFakeTimers();
    const seen: AppEvent[] = [];
    const off = onEvent((ev) => seen.push(ev));
    expect(made).toHaveLength(1);
    made[0].emit({ type: 'refsUpdated', repo: 1 });
    made[0].closed();
    vi.advanceTimersByTime(RECONNECT_MS);
    expect(made).toHaveLength(2);
    made[1].emit({ type: 'refsUpdated', repo: 2 });
    expect(seen).toEqual([{ type: 'refsUpdated', repo: 1 }, { type: 'refsUpdated', repo: 2 }]);
    off();
    made[1].emit({ type: 'refsUpdated', repo: 3 });
    expect(seen).toHaveLength(2);
    // Nobody listens any more: a drop doesn't reconnect.
    made[1].closed();
    vi.advanceTimersByTime(RECONNECT_MS * 4);
    expect(made).toHaveLength(2);
  });

  it('a handler that throws is logged and the others still get the event', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: AppEvent[] = [];
    const offBad = onEvent(() => { throw new Error('bad handler'); });
    const off = onEvent((ev) => seen.push(ev));
    made.at(-1)!.emit({ type: 'refsUpdated', repo: 9 });
    expect(seen).toEqual([{ type: 'refsUpdated', repo: 9 }]);
    expect(error).toHaveBeenCalled();
    offBad();
    off();
    error.mockRestore();
  });
});
