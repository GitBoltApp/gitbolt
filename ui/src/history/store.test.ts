import { describe, expect, it, vi } from 'vitest';
vi.mock('../api/client', () => ({ errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
import { createHistoryStore } from './store';
import { row } from './testRows';

const args = { repoId: 1, worktree: '/r', path: 'src/story.txt', rev: null, blame: true };

describe('the File History store', () => {
  it('loads one page at a time; seek walks pages until its commit shows', async () => {
    const pages = [{ rows: [row('a'), row('b')], more: true }, { rows: [row('c')], more: false }];
    const fetch = vi.fn(async (skip: number) => pages[skip === 0 ? 0 : 1]);
    const store = createHistoryStore(args, fetch);
    expect(store.getState().blame).toBe(true);
    const p1 = store.getState().loadMore();
    expect(store.getState().loadMore()).toBe(p1);
    await p1;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.getState().selected).toBe('a');
    expect(await store.getState().seek('c')).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith(2);
    expect(store.getState().selected).toBe('c');
    expect(await store.getState().seek('zzz')).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a failed page keeps the rows and says why; loading again retries it', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ rows: [row('a')], more: true }).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ rows: [row('b')], more: false });
    const store = createHistoryStore(args, fetch);
    await store.getState().loadMore();
    await store.getState().loadMore();
    expect(store.getState().error).toBe('boom');
    expect(store.getState().rows.map((r) => r.sha)).toEqual(['a']);
    expect(await store.getState().seek('b')).toBe(false);
    await store.getState().loadMore();
    expect(store.getState().rows.map((r) => r.sha)).toEqual(['a', 'b']);
    expect(store.getState().error).toBeNull();
  });
});
