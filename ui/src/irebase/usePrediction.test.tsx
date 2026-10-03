import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPlan } from './model';
import { usePrediction } from './predict';
import { editState, NO_PREDICTION, sessionOf, setSession } from './session';
import { oid, plan } from './testPlan';

const predictRebase = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: { predictRebase } }));

const ctx = { tabId: 't1', repoId: 1, worktree: '/r' };
function Probe() {
  usePrediction('t1');
  return null;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  setSession('t1', undefined);
  vi.clearAllMocks();
});

describe('usePrediction (spec #3 §3.2)', () => {
  it('predicts again when the base moves under the same rows (a Reload): the old marks go', async () => {
    setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: fromPlan(plan()), prediction: NO_PREDICTION, moved: null, editing: null });
    predictRebase.mockResolvedValue({ rows: [{ oid: oid('c'), conflicts: ['x.txt'] }], off: null });
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(predictRebase).toHaveBeenCalledTimes(1);
    expect(predictRebase.mock.calls[0][2]).toBe(oid('0'));
    expect(sessionOf('t1')!.prediction.byRow).toEqual({ [oid('c')]: ['x.txt'] });

    predictRebase.mockResolvedValue({ rows: [{ oid: oid('c'), conflicts: [] }], off: null });
    act(() => editState('t1', (s) => ({ ...s, base: { ...s.base, oid: oid('9') } })));
    expect(sessionOf('t1')!.prediction.status).toBe('pending');
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(predictRebase).toHaveBeenCalledTimes(2);
    expect(predictRebase.mock.calls[1][2]).toBe(oid('9'));
    expect(sessionOf('t1')!.prediction).toEqual({ status: 'ready', byRow: {}, first: null, note: null });
  });

  it('a message edit (no change to order, drops or base) predicts nothing new', async () => {
    setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: fromPlan(plan()), prediction: NO_PREDICTION, moved: null, editing: null });
    predictRebase.mockResolvedValue({ rows: [], off: null });
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    act(() => editState('t1', (s) => ({ ...s, rows: s.rows.map((r, i) => (i === 0 ? { ...r, edited: 'New\n' } : r)) })));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(predictRebase).toHaveBeenCalledTimes(1);
  });
});
