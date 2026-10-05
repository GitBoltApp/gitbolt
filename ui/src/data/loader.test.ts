import { describe, expect, it } from 'vitest';
import { DroppedError, Loader } from './loader';
import { Lru } from './lru';

function deferred() {
  const calls: string[] = [];
  const pending = new Map<string, { resolve: (v: string) => void; reject: (e: unknown) => void }>();
  const fetcher = (key: string) => new Promise<string>((resolve, reject) => {
    calls.push(key);
    pending.set(key, { resolve, reject });
  });
  return { calls, pending, fetcher };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Loader', () => {
  it('dedupes concurrent loads and caches results', async () => {
    const { calls, pending, fetcher } = deferred();
    const l = new Loader(fetcher, new Lru(10));
    const a = l.get('a');
    const b = l.get('a');
    expect(calls).toEqual(['a']);
    pending.get('a')!.resolve('A');
    expect([await a, await b]).toEqual(['A', 'A']);
    await flush();
    expect(await l.get('a')).toBe('A');
    expect(l.peek('a')).toBe('A');
    expect(calls).toEqual(['a']);
  });

  it('runs "now" loads before queued prefetches', async () => {
    const { calls, pending, fetcher } = deferred();
    const l = new Loader(fetcher, new Lru(10), 1);
    void l.get('a');
    l.prefetch(['b', 'c']);
    void l.get('d');
    for (const k of ['a', 'd', 'b']) {
      pending.get(k)!.resolve(k.toUpperCase());
      await flush();
    }
    expect(calls).toEqual(['a', 'd', 'b', 'c']);
  });

  it('a reserve slot lets a "now" load start while prefetches fill the others', async () => {
    const { calls, fetcher } = deferred();
    const l = new Loader(fetcher, new Lru(10), 2, () => true, 1);
    l.prefetch(['a', 'b', 'c']);
    expect(calls).toEqual(['a', 'b']);
    void l.get('d');
    expect(calls).toEqual(['a', 'b', 'd']);
    void l.get('e');
    expect(calls).toEqual(['a', 'b', 'd']); // the reserve is one slot
  });

  it('latest request wins: a superseded prefetch is dropped before it is ever sent', async () => {
    const { calls, pending, fetcher } = deferred();
    const l = new Loader(fetcher, new Lru(10), 1);
    void l.get('a');
    l.prefetch(['b']);
    l.prefetch(['c']);
    pending.get('a')!.resolve('A');
    await flush();
    expect(calls).toEqual(['a', 'c']);
  });

  it('a "now" load promotes a queued prefetch so a later prefetch cannot drop it', async () => {
    const { calls, pending, fetcher } = deferred();
    const l = new Loader(fetcher, new Lru(10), 1);
    void l.get('a');
    l.prefetch(['b']);
    const b = l.get('b');
    l.prefetch(['c']);
    pending.get('a')!.resolve('A');
    await flush();
    expect(calls).toEqual(['a', 'b']);
    pending.get('b')!.resolve('B');
    expect(await b).toBe('B');
  });

  it('does not cache failures or uncacheable keys', async () => {
    let n = 0;
    const l = new Loader(async (k: string) => {
      n++;
      if (n === 1) throw new Error('boom');
      return k;
    }, new Lru<string, string>(10), 4, (k) => k !== 'live');
    await expect(l.get('x')).rejects.toThrow('boom');
    await flush();
    expect(await l.get('x')).toBe('x');
    await l.get('live');
    await flush();
    await l.get('live');
    expect(n).toBe(4);
  });

  // Controller ruling F4: the fetcher runs synchronously inside `get`, so a request is on the
  // wire before `get` returns, and a fetcher that throws synchronously rejects the load
  // (and frees its slot) instead of escaping from `get`.
  it('calls the fetcher synchronously and turns a synchronous throw into a rejection', async () => {
    let n = 0;
    const l = new Loader<string>((k) => {
      n++;
      if (k === 'bad') throw new Error('sync boom');
      return Promise.resolve(k);
    }, new Lru(10), 1);
    const bad = l.get('bad');
    expect(n).toBe(1);
    await expect(bad).rejects.toThrow('sync boom');
    await flush();
    expect(await l.get('ok')).toBe('ok');
    expect(n).toBe(2);
  });

  it('a dropped prefetch rejects with DroppedError and can be requested again', async () => {
    const { calls, pending, fetcher } = deferred();
    const l = new Loader(fetcher, new Lru(10), 1);
    void l.get('a');
    const b = l.get('b', 'prefetch');
    l.prefetch(['c']);
    await expect(b).rejects.toBeInstanceOf(DroppedError);
    const again = l.get('b');
    pending.get('a')!.resolve('A');
    await flush();
    expect(calls).toEqual(['a', 'b']);
    pending.get('b')!.resolve('B');
    expect(await again).toBe('B');
  });

  // Review fix 5: a hit served through `peek` counts as a use (LRU, not FIFO).
  it('a cache hit read through peek refreshes its recency', async () => {
    const l = new Loader(async (k: string) => k.toUpperCase(), new Lru<string, string>(2));
    await l.get('a');
    await l.get('b');
    await flush();
    expect(l.peek('a')).toBe('A');
    await l.get('c');
    await flush();
    expect([l.cache.has('a'), l.cache.has('b'), l.cache.has('c')]).toEqual([true, false, true]);
  });
});
