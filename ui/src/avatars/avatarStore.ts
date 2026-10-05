import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { useRepoContext } from '../app/repoContext';
import type { AvatarPayload } from '../api/gen/AvatarPayload';
import { DroppedError, Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { avatarKey } from './color';

export interface AvatarImage {
  /** An object URL for `<img>`. Revoked when the image is evicted. */
  url: string;
  /** Decoded (and downscaled) for the graph canvas; null where the platform can't decode one.
   * Closed when the image is evicted. */
  bitmap: ImageBitmap | null;
}

export interface AvatarStore {
  /** The loaded image (marking it recently used), or null: not requested, in flight, dropped,
   * evicted, failed, or there's no avatar. */
  get(email: string): AvatarImage | null;
  /** Asks for one avatar now (the details panel). Never dropped by `requestVisible`. `repo`, here
   * and below: the tab asking (its forge project is the backend's last place to look). */
  request(email: string, repo?: number): void;
  /** Asks for one avatar at prefetch priority (a neighbouring commit's people): behind
   * `request`s, never in their reserved slots. Dropped by the next `requestVisible` if still
   * queued, and asked for again when it's wanted. */
  prefetchOne(email: string, repo?: number): void;
  /**
   * The graph's visible rows, latest set wins: queued, unstarted requests for emails no longer
   * in the set are dropped (and asked for again if they come back), so a fast scroll through a
   * long history doesn't leave a backlog of avatar requests behind it.
   */
  requestVisible(emails: string[], repo?: number): void;
  /** Called after an avatar arrives (and after any it evicted). */
  subscribe(listener: () => void): () => void;
  /** Bumped by every such change. */
  version(): number;
  /** Forgets every image and every "no avatar" answer, so all are asked for again (the Gravatar
   * setting changed: what the backend answers is different now). Bumps `epoch` and `version`. */
  reset(): void;
  /** Bumped only by `reset`: components that gave up on an avatar ask again. */
  epoch(): number;
}

export { avatarKey };

/** The largest avatar drawn, in CSS px (the details header's author). Bitmaps are decoded at this
 * size × devicePixelRatio (at most 2×): big enough for every use, and small in memory. */
export const LARGEST_AVATAR_PX = 28;
/** Requests past the concurrency limit that only `request` (the details panel) may use: the
 * people in the panel never wait behind the graph's rows already on the network. */
const URGENT_SLOTS = 2;
/** Images kept (bitmap + object URL each); the least recently used is evicted beyond it. */
export const AVATAR_CACHE_ENTRIES = 512;

async function decode(p: AvatarPayload): Promise<AvatarImage> {
  const blob = new Blob([Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0))], { type: p.mime });
  const side = Math.round(LARGEST_AVATAR_PX * Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1)));
  const bitmap = typeof createImageBitmap === 'function'
    ? await createImageBitmap(blob, { resizeWidth: side, resizeHeight: side, resizeQuality: 'high' }).catch(() => null)
    : null;
  return { url: URL.createObjectURL(blob), bitmap };
}

function release(img: AvatarImage) {
  img.bitmap?.close();
  URL.revokeObjectURL(img.url);
}

/**
 * Avatars keyed by trimmed, lowercased email, fetched at most 4 at a time through `fetchAvatar`
 * (the backend call: the UI never contacts an avatar host itself). An email is fetched once
 * unless its request was dropped or its image evicted; "no avatar" is remembered for the session.
 */
export function createAvatarStore(fetchAvatar: (email: string, repo?: number) => Promise<AvatarPayload | null>, { concurrency = 4, capacity = AVATAR_CACHE_ENTRIES, keyOf = avatarKey } = {}): AvatarStore {
  /** Loaded images, least recently used first. */
  const images = new Map<string, AvatarImage>();
  /** Queued or in flight, with the load that settles it. */
  const pending = new Map<string, Promise<AvatarImage | null>>();
  /** Known to have no avatar (or its request failed): not asked again this session. */
  const none = new Set<string>();
  /** The tab that last asked for each key (an open repo's id). */
  const repos = new Map<string, number>();
  const noteRepo = (key: string, repo: number | undefined) => {
    if (repo !== undefined && repo >= 0) repos.set(key, repo);
  };
  const listeners = new Set<() => void>();
  let version = 0;
  let epoch = 0;
  // Only the concurrency limit, the queue and dropping: `images` is the cache (never the
  // loader's, which could hand back a bitmap already closed on eviction).
  const loader = new Loader<AvatarImage | null>(async (key) => {
    const repo = repos.get(key);
    const p = await (repo === undefined ? fetchAvatar(key) : fetchAvatar(key, repo));
    return p ? decode(p) : null;
  }, new Lru(1), concurrency, () => false, URGENT_SLOTS);

  const notify = () => {
    version++;
    for (const l of listeners) l();
  };
  const known = (key: string) => images.has(key) || none.has(key);
  // Follows the loader's promise for `key`. Keyed by identity: a dropped job's rejection lands a
  // microtask later, possibly after a new load for the same key has started.
  const track = (key: string, p: Promise<AvatarImage | null>) => {
    if (pending.get(key) === p) return;
    pending.set(key, p);
    const settled = () => {
      if (pending.get(key) !== p) return false;
      pending.delete(key);
      return true;
    };
    p.then(
      (img) => {
        // A result is kept even if a newer load for the key started meanwhile (never leaked).
        settled();
        if (!img) {
          if (!images.has(key)) none.add(key);
          return;
        }
        const prev = images.get(key);
        if (prev) release(prev);
        images.delete(key);
        images.set(key, img);
        while (images.size > capacity) {
          const [oldest, old] = images.entries().next().value!;
          images.delete(oldest);
          release(old);
        }
        notify();
      },
      (e: unknown) => {
        if (!settled()) return;
        // Dropped before it started: forget it, so it's asked for again when it's back on screen.
        if (!(e instanceof DroppedError)) none.add(key);
      },
    );
  };

  return {
    get(email) {
      const key = keyOf(email);
      const img = images.get(key);
      if (!img) return null;
      images.delete(key);
      images.set(key, img);
      return img;
    },
    request(email, repo) {
      const key = keyOf(email);
      if (!key || known(key)) return;
      noteRepo(key, repo);
      // Already queued as a visible-rows prefetch: `get` promotes it, so it's never dropped.
      track(key, loader.get(key));
    },
    prefetchOne(email, repo) {
      const key = keyOf(email);
      if (!key || known(key) || pending.has(key)) return;
      noteRepo(key, repo);
      track(key, loader.get(key, 'prefetch'));
    },
    requestVisible(emails, repo) {
      const keys = [...new Set(emails.map(keyOf))].filter((k) => k && !known(k));
      for (const k of keys) noteRepo(k, repo);
      loader.prefetch(keys);
      for (const k of keys) track(k, loader.get(k, 'prefetch'));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    version: () => version,
    epoch: () => epoch,
    reset() {
      for (const img of images.values()) release(img);
      images.clear();
      none.clear();
      epoch++;
      notify();
    },
  };
}

/**
 * The app's avatars (details panel and graph nodes share them): Gravatar, fetched and
 * disk-cached by the backend (spec §14.3). Initials show until, or unless, one arrives.
 */
export const avatars = createAvatarStore((...ask) => api.avatar(...ask));

/**
 * Forge users' pictures by the URL the forge gave (`ForgeUser.avatarUrl`: MR/PR authors, reviewers,
 * note authors, who carry no email). The backend fetches and disk-caches them like the others,
 * only from the accounts' own hosts and the forges' avatar hosts. Keyed by the URL as given (a
 * path is case-sensitive).
 */
export const forgeAvatars = createAvatarStore((url) => api.forgeAvatarImage(url), { keyOf: (url) => url.trim() });

/** Both stores forget what they have (the Gravatar or forge-avatar setting, or the accounts, changed). */
export function resetAvatars(): void {
  avatars.reset();
  forgeAvatars.reset();
}

/** Which store `Avatar` reads: the app's, unless a test provides its own. */
export const AvatarStoreContext = createContext<AvatarStore>(avatars);
/** Which store `Avatar` reads for a forge user's `url`. */
export const ForgeAvatarStoreContext = createContext<AvatarStore>(forgeAvatars);

/** `request: false`: only read the cache; someone else asks for it (the graph's visible-rows
 * requests, whose latest set wins on a fast scroll). `byUrl`: `email` is a forge avatar URL. */
export function useAvatar(email: string, request = true, byUrl = false): AvatarImage | null {
  const byEmail = useContext(AvatarStoreContext);
  const forUrl = useContext(ForgeAvatarStoreContext);
  const store = byUrl ? forUrl : byEmail;
  const repo = useRepoContext().repoId;
  // The snapshot is this email's own entry: only its own arrival or eviction re-renders.
  const img = useSyncExternalStore(store.subscribe, () => store.get(email));
  // Changes only on `reset` (the Gravatar setting), when a "no avatar" answer must be re-asked.
  const epoch = useSyncExternalStore(store.subscribe, store.epoch);
  // Asks again after an eviction too (`img` goes back to null).
  useEffect(() => {
    if (!img && request) store.request(email, repo);
  }, [store, email, img, request, epoch, repo]);
  return img;
}
