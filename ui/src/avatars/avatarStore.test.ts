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

  it('runs at most 4 requests at a time', async () => {
    const m = manual();
    const avatars = createAvatarStore(m.fetch);
    for (let i = 0; i < 6; i++) avatars.request(`u${i}@example.com`);
    expect(m.fetch).toHaveBeenCalledTimes(4);
    m.settle('u0@example.com', null);
    await flush();
    expect(m.fetch).toHaveBeenCalledTimes(5);
  });

  it('visible rows are latest-wins: a newer set drops the older set\'s queued requests, which can be asked for again later', async () => {
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
