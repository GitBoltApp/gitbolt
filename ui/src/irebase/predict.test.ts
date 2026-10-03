import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPredictor, predictionView } from './predict';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const rows = (n: number) => [{ oid: String(n).repeat(40), action: 'pick' as const }];

describe('conflict prediction in the editor (spec #3 §3.2)', () => {
  it('debounces 250 ms after the last change and drops answers that a newer change overtook', async () => {
    const answers: Array<(p: { rows: { oid: string; conflicts: string[] }[]; off: string | null }) => void> = [];
    const send = vi.fn(() => new Promise<{ rows: { oid: string; conflicts: string[] }[]; off: string | null }>((res) => answers.push(res)));
    const seen: unknown[] = [];
    const p = createPredictor(send, (v) => seen.push(v));
    p.schedule(rows(1));
    vi.advanceTimersByTime(200);
    p.schedule(rows(2));
    vi.advanceTimersByTime(249);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(rows(2));
    p.schedule(rows(3));
    answers[0]({ rows: [{ oid: 'c'.repeat(40), conflicts: ['a.txt'] }], off: null });
    await vi.runAllTimersAsync();
    answers[1]({ rows: [], off: null });
    await vi.runAllTimersAsync();
    expect(seen).toEqual([{ status: 'ready', byRow: {}, first: null, note: null }]);
  });

  it('cancel stops a pending one', () => {
    const send = vi.fn(() => new Promise<never>(() => {}));
    const p = createPredictor(send, () => {});
    p.schedule(rows(1));
    p.cancel();
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
  });

  it('maps the core answer: conflicts by row, the first one, or why it is off', () => {
    expect(predictionView({ rows: [{ oid: 'a', conflicts: [] }, { oid: 'b', conflicts: ['x.txt', 'y.txt'] }, { oid: 'c', conflicts: ['x.txt'] }], off: null }))
      .toEqual({ status: 'ready', byRow: { b: ['x.txt', 'y.txt'], c: ['x.txt'] }, first: 'b', note: null });
    expect(predictionView({ rows: [], off: 'Prediction is off for ranges over 300 commits' }))
      .toEqual({ status: 'off', byRow: {}, first: null, note: 'Prediction is off for ranges over 300 commits' });
  });
});
