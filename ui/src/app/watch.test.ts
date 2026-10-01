import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
vi.mock('../api/client', () => ({
  api: {
    watchRepo: vi.fn(async (r: number) => { await new Promise((res) => setTimeout(res, 5)); calls.push(`watch ${r}`); }),
    unwatchRepo: vi.fn(async (r: number) => { await new Promise((res) => setTimeout(res, 5)); calls.push(`unwatch ${r}`); }),
  },
}));

const { setWatched } = await import('./watch');

describe('setWatched', () => {
  beforeEach(() => { calls.length = 0; });

  it('setWatched coalesces to the final desired state', async () => {
    // StrictMode: mount, unmount, mount, all before the first call finishes.
    setWatched(1, true);
    setWatched(1, false);
    setWatched(1, true);
    await vi.waitFor(() => expect(calls.at(-1)).toBe('watch 1'));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(['watch 1']);
  });

  it('serializes per repo and ends unwatched when that is the last request', async () => {
    setWatched(2, true);
    await vi.waitFor(() => expect(calls).toEqual(['watch 2']));
    setWatched(2, false);
    await vi.waitFor(() => expect(calls).toEqual(['watch 2', 'unwatch 2']));
  });

  it('resolves once the latest wish is applied', async () => {
    const first = setWatched(5, true);
    const second = setWatched(5, false);
    expect(second).toBe(first);
    await second;
    expect(calls).toEqual(['watch 5', 'unwatch 5']);
  });

  it('a tab switch (unwatch one repo, watch another) reaches both', async () => {
    setWatched(3, true);
    await vi.waitFor(() => expect(calls).toEqual(['watch 3']));
    setWatched(3, false);
    setWatched(4, true);
    await vi.waitFor(() => expect([...calls].sort()).toEqual(['unwatch 3', 'watch 3', 'watch 4']));
  });
});
