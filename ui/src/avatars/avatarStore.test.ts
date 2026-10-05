import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarPayload } from '../api/gen/AvatarPayload';
import { AVATAR_CACHE_ENTRIES, LARGEST_AVATAR_PX, createAvatarStore } from './avatarStore';

let urls = 0;
beforeEach(() => {
  urls = 0;
  URL.createObjectURL = vi.fn(() => `blob:avatar-${++urls}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const png: AvatarPayload = { mime: 'image/png', base64: btoa('png') };

/** A fetcher whose calls the test settles one by one. */
function manual() {
  const pending = new Map<string, (v: AvatarPayload | null) => void>();
  const fetch = vi.fn((email: string) => new Promise<AvatarPayload | null>((r) => pending.set(email, r)));
  const fetched = () => fetch.mock.calls.map((c) => c[0]);
  return { fetch, fetched, settle: (email: string, v: AvatarPayload | null = png) => pending.get(email)!(v) };
}

describe('avatar store', () => {
  it('requests each email once, by trimmed lowercased email, and notifies subscribers', async () => {
    const fetch = vi.fn(async (email: string) => (email === 'ada@example.com' ? png : null));
    const avatars = createAvatarStore(fetch);
    const seen = vi.fn();
    const unsubscribe = avatars.subscribe(seen);
    avatars.request('Ada@Example.com');
    avatars.request(' ada@example.com ');
    avatars.request('nobody@example.com');
    avatars.request('   ');
    await flush();
    await flush();
    expect(fetch.mock.calls.map((c) => c[0]).sort()).toEqual(['ada@example.com', 'nobody@example.com']);
    expect(avatars.get('ADA@example.com')?.url).toBe('blob:avatar-1');
    expect(avatars.get('nobody@example.com')).toBeNull();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(avatars.version()).toBe(1);
    avatars.request('ada@example.com');
    avatars.request('nobody@example.com');
    avatars.requestVisible(['ada@example.com', 'nobody@example.com']);
    expect(fetch).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('passes the asking tab\'s repo to the fetch (its GitHub project is the last place looked), none outside a tab', async () => {
    const fetch = vi.fn(async (_email: string, _repo?: number) => null);
    const avatars = createAvatarStore(fetch);
    avatars.requestVisible(['ada@example.com'], 3);
    avatars.prefetchOne('grace@example.com', 4);
    avatars.request('linus@example.com', -1);
    await flush();
    await flush();
    expect(Object.fromEntries(fetch.mock.calls.map((c) => [c[0], c[1]]))).toEqual({ 'ada@example.com': 3, 'grace@example.com': 4, 'linus@example.com': undefined });
  });

  it('reset forgets images and "no avatar" answers, so every email is asked for again (the Gravatar setting changed)', async () => {
    const fetch = vi.fn(async (email: string) => (email === 'ada@example.com' ? png : null));
    const avatars = createAvatarStore(fetch);
    avatars.request('ada@example.com');
    avatars.request('nobody@example.com');
    await flush();
    await flush();
    expect(avatars.get('ada@example.com')).not.toBeNull();
    const [version, epoch] = [avatars.version(), avatars.epoch()];
    const seen = vi.fn();
    avatars.subscribe(seen);
    avatars.reset();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(avatars.version()).toBe(version + 1);
    expect(avatars.epoch()).toBe(epoch + 1);
    expect(avatars.get('ada@example.com')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-1');
    avatars.request('ada@example.com');
    avatars.request('nobody@example.com');
    await flush();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(avatars.get('ada@example.com')).not.toBeNull();
  });

  it('runs at most 4 requests at a time, plus 2 kept for the details panel\'s people', async () => {
    const m = manual();
    const avatars = createAvatarStore(m.fetch);
    avatars.requestVisible(Array.from({ length: 6 }, (_, i) => `row${i}@example.com`));
    expect(m.fetch).toHaveBeenCalledTimes(4);
    // The panel's committer and co-authors don't wait for the graph's rows on the network.
    for (let i = 0; i < 3; i++) avatars.request(`u${i}@example.com`);
    expect(m.fetched().slice(4)).toEqual(['u0@example.com', 'u1@example.com']);
    m.settle('u0@example.com', null);
    await flush();
    expect(m.fetched().slice(6)).toEqual(['u2@example.com']);
  });

  it('neighbours\' people (prefetchOne) never take the reserved slots, and the selected commit\'s co-author goes first', async () => {
    const m = manual();
    const avatars = createAvatarStore(m.fetch);
    avatars.requestVisible(Array.from({ length: 4 }, (_, i) => `row${i}@example.com`));
    for (let i = 0; i < 3; i++) avatars.prefetchOne(`near${i}@example.com`);
    expect(m.fetched()).toHaveLength(4); // all 4 slots are the graph's; the reserve stays free
    avatars.request('co@example.com');
    expect(m.fetched()[4]).toBe('co@example.com'); // a reserved slot, at once
    m.settle('row0@example.com', null);
    await flush();
    expect(m.fetched()).toHaveLength(5); // 4 running (3 rows + the co-author): no prefetch slot yet
    m.settle('co@example.com', null);
    await flush();
    expect(m.fetched().slice(5)).toEqual(['near0@example.com']); // then the neighbours, within the 4
  });

  it('a queued neighbour avatar the user then selects is promoted ahead of the others', async () => {
    const m = manual();
    const avatars = createAvatarStore(m.fetch, { concurrency: 1 });
    avatars.request('busy@example.com');
    avatars.request('busy2@example.com');
    avatars.request('busy3@example.com'); // concurrency 1 + 2 reserved: all three running
    avatars.prefetchOne('a@example.com');
    avatars.prefetchOne('b@example.com');
    avatars.request('b@example.com');
    m.settle('busy@example.com', null);
    await flush();
    expect(m.fetched().slice(3, 4)).toEqual(['b@example.com']);
  });

  it('visible rows are latest-wins:a newer set drops the older set\'s queued requests, which can be asked for again later', async () => {
    const m = manual();
    const avatars = createAvatarStore(m.fetch);
    const a = Array.from({ length: 8 }, (_, i) => `a${i}@example.com`);
    const b = Array.from({ length: 3 }, (_, i) => `b${i}@example.com`);
    avatars.requestVisible(a);
    expect(m.fetched()).toEqual(a.slice(0, 4)); // 4 started, 4 queued
    avatars.requestVisible(b); // fast scroll: set B before A drains
    for (const e of a.slice(0, 4)) m.settle(e, null);
    await flush();
    for (const e of b) m.settle(e, null);
    await flush();
    // A's queued (never started) jobs were dropped: never fetched. B was.
    expect(m.fetched()).toEqual([...a.slice(0, 4), ...b]);
    // Scrolling back: the dropped emails are requested again.
    avatars.requestVisible([a[5]]);
    expect(m.fetched().at(-1)).toBe(a[5]);
  });

  it('a details avatar (request) is never dropped by a visible-rows update', async () => {
    const m = manual();
    const avatars = createAvatarStore(m.fetch);
    avatars.requestVisible(['a0@x', 'a1@x', 'a2@x', 'a3@x', 'a4@x']);
    avatars.request('a4@x'); // queued as a prefetch: promoted
    avatars.requestVisible([]);
    m.settle('a0@x', null);
    await flush();
    expect(m.fetched()).toEqual(['a0@x', 'a1@x', 'a2@x', 'a3@x', 'a4@x']);
  });

  it(`decodes a bitmap resized to the largest avatar (${LARGEST_AVATAR_PX}px x DPR, at most 2x), and a failed request counts as no avatar`, async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createImageBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    vi.stubGlobal('devicePixelRatio', 3);
    const avatars = createAvatarStore(async (email) => {
      if (email === 'boom@example.com') throw new Error('offline');
      return png;
    });
    avatars.request('ada@example.com');
    avatars.request('boom@example.com');
    await flush();
    await flush();
    expect(avatars.get('ada@example.com')?.bitmap).toBe(bitmap);
    const side = LARGEST_AVATAR_PX * 2;
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { resizeWidth: side, resizeHeight: side, resizeQuality: 'high' });
    expect(avatars.get('boom@example.com')).toBeNull();
  });

  it(`keeps at most ${AVATAR_CACHE_ENTRIES} images by default; an evicted one is closed, revoked, and requested again on demand`, async () => {
    expect(AVATAR_CACHE_ENTRIES).toBe(512);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
    const fetch = vi.fn(async () => png);
    const avatars = createAvatarStore(fetch, { capacity: 2 });
    const seen = vi.fn();
    avatars.subscribe(seen);
    for (const e of ['a@x', 'b@x']) avatars.request(e);
    await flush();
    await flush();
    const b = avatars.get('b@x')!;
    const a = avatars.get('a@x')!; // a is now the most recently used
    const close = (img: { bitmap: ImageBitmap | null }) => (img.bitmap as unknown as { close: ReturnType<typeof vi.fn> }).close;
    avatars.request('c@x');
    await flush();
    await flush();
    // b was least recently used: evicted.
    expect(avatars.get('b@x')).toBeNull();
    expect(avatars.get('a@x')).toBe(a);
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(b.url);
    expect(close(b)).toHaveBeenCalledOnce();
    expect(close(a)).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledTimes(3);
    avatars.request('b@x');
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
