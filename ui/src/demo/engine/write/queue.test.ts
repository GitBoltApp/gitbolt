import { describe, expect, it } from 'vitest';
import type { QueueStatePayload } from '../../../api/gen/QueueStatePayload';
import { gbError } from '../errors';
import { WriteQueue } from './queue';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the write queue', () => {
  it('runs items in click order, announces each change, and carries expect forward', async () => {
    const seen: QueueStatePayload[] = [];
    const q = new WriteQueue((s) => seen.push(s));
    const a = q.enqueue('commit "a"', 'commit', 1);
    const b = q.enqueue('checkout x', 'checkout', 2);
    expect(q.state().queued.map((i) => i.label)).toEqual(['commit "a"', 'checkout x']);
    const sa = await q.turn(a);
    let bStarted = false;
    const tb = q.turn(b).then((s) => ((bStarted = true), s));
    await flush();
    expect([bStarted, q.state().running?.label]).toEqual([false, 'commit "a"']);
    q.finish(null, [{ name: 'HEAD', old: 'h1', new: 'h2' }]);
    (await sa.lock())();
    const sb = await tb;
    expect(sb.carry({ head: 'h1', refs: {} })).toEqual({ head: 'h2', refs: {} });
    q.finish(null, []);
    (await sb.lock())();
    expect(seen.at(-1)).toEqual({ running: null, queued: [], stopped: null });
  });

  it('runs a background fetch only while idle; an enqueue cancels it and waits for it to stop', async () => {
    const q = new WriteQueue(() => {});
    let cancelled = 0;
    const bg = q.tryBackground(() => cancelled++)!;
    expect(bg).not.toBeNull();
    expect(q.tryBackground(() => {})).toBeNull();
    const a = q.enqueue('commit "a"', 'commit', 1);
    expect(cancelled).toBe(1);
    let started = false;
    const ta = q.turn(a).then((s) => ((started = true), s));
    await flush();
    expect(started).toBe(false);
    bg.end();
    const sa = await ta;
    expect(q.tryBackground(() => {})).toBeNull();
    q.finish(null, []);
    (await sa.lock())();
    expect(q.tryBackground(() => {})).not.toBeNull();
  });

  it('stops what is queued behind a failure until Resume, and Clear drops it', async () => {
    const q = new WriteQueue(() => {});
    const a = q.enqueue('one', 'commit', 1);
    const b = q.enqueue('two', 'commit', 2);
    const sa = await q.turn(a);
    q.finish(gbError('HookFailed', 'pre-commit hook failed'), []);
    (await sa.lock())();
    expect(q.state().stopped).toEqual({ label: 'one', message: 'pre-commit hook failed' });
    const tb = q.turn(b);
    q.clear();
    await expect(tb).rejects.toMatchObject({ kind: 'Cancelled', message: 'Removed from the queue' });
    expect(q.state()).toEqual({ running: null, queued: [], stopped: null });
  });
});
