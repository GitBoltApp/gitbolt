import { describe, expect, it, vi } from 'vitest';
import type { QueueStatePayload } from '../api/gen/QueueStatePayload';
import { applyQueueEvent, loadQueue, chipText, isIdle, useQueue } from './store';

const queueState = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: { queueState } }));

const item = (id: number, label: string) => ({ id, label, kind: 'push' as const, op: id + 100 });

describe('the action queue chip (spec #2 §3.6)', () => {
  it('says what runs and how many wait, or what stopped and how many did not run', () => {
    expect(chipText({ running: item(1, 'push dev'), queued: [item(2, 'b'), item(3, 'c')], stopped: null })).toBe('Running: push dev · 2 queued');
    expect(chipText({ running: item(1, 'push dev'), queued: [], stopped: null })).toBe('Running: push dev');
    expect(chipText({ running: null, queued: [item(2, 'b'), item(3, 'c')], stopped: { label: 'push dev', message: 'rejected' } })).toBe('Stopped: push dev failed · 2 not run');
    expect(chipText({ running: null, queued: [item(2, 'b')], stopped: null })).toBe('1 queued');
  });

  it('is hidden when idle', () => {
    expect(isIdle(undefined)).toBe(true);
    expect(isIdle({ running: null, queued: [], stopped: null })).toBe(true);
    expect(isIdle({ running: item(1, 'a'), queued: [], stopped: null })).toBe(false);
  });

  it('follows queueChanged per repo', () => {
    const s: QueueStatePayload = { running: item(1, 'a'), queued: [], stopped: null };
    applyQueueEvent({ type: 'queueChanged', repo: 4, ...s });
    expect(useQueue.getState().byRepo[4]).toEqual(s);
    applyQueueEvent({ type: 'refsUpdated', repo: 4 });
    expect(useQueue.getState().byRepo[4]).toEqual(s);
  });

  it('loadQueue does not overwrite a queueChanged that arrived while it was in flight', async () => {
    useQueue.setState({ byRepo: {} });
    let resolve!: (s: QueueStatePayload) => void;
    queueState.mockReturnValueOnce(new Promise<QueueStatePayload>((r) => { resolve = r; }));
    const loading = loadQueue(7);
    const fresh: QueueStatePayload = { running: item(1, 'a'), queued: [], stopped: null };
    applyQueueEvent({ type: 'queueChanged', repo: 7, ...fresh });
    resolve({ running: null, queued: [], stopped: null });
    await loading;
    expect(useQueue.getState().byRepo[7]).toEqual(fresh);
  });
});
