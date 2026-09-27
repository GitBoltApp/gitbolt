import { describe, expect, it, vi } from 'vitest';
import type { CommitMessage } from './gen/CommitMessage';
import { createCommitMessageCache } from './commitMessages';

const msg = (id: string): CommitMessage => ({ id, summary: `s-${id}`, body: `b-${id}` });

describe('createCommitMessageCache', () => {
  it('loads once per commit id and serves repeats from the cache', async () => {
    const load = vi.fn(async (id: string) => msg(id));
    const cache = createCommitMessageCache(load);
    expect(cache.peek('a')).toBeUndefined();
    const [x, y] = await Promise.all([cache.get('a'), cache.get('a')]);
    expect(x).toEqual(msg('a'));
    expect(y).toBe(x);
    expect(await cache.get('a')).toBe(x);
    expect(cache.peek('a')).toBe(x);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used entry beyond its capacity (default ~200)', async () => {
    const load = vi.fn(async (id: string) => msg(id));
    const cache = createCommitMessageCache(load, 3);
    for (const id of ['a', 'b', 'c']) await cache.get(id);
    cache.peek('a'); // touch: now b is the least recently used
    await cache.get('d');
    expect(cache.peek('b')).toBeUndefined();
    expect(cache.peek('a')).toEqual(msg('a'));
    expect(cache.peek('c')).toEqual(msg('c'));
    expect(cache.peek('d')).toEqual(msg('d'));
    expect(createCommitMessageCache(load).capacity).toBe(200);
  });

  it('does not cache failures', async () => {
    const load = vi.fn(async (id: string) => { if (load.mock.calls.length === 1) throw new Error('boom'); return msg(id); });
    const cache = createCommitMessageCache(load);
    await expect(cache.get('a')).rejects.toThrow('boom');
    expect(await cache.get('a')).toEqual(msg('a'));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
