import { api, onEvent } from '../api/client';
import type { LastPushPayload } from '../api/gen/LastPushPayload';

/**
 * Per-repo `lastPush` cache for the sidebar hover card (fix round 1, item 7). The card shows
 * instantly (amendment 3), so a fast sweep across many branch rows must not fire one backend
 * request per row: keyed by repo + remote ref, concurrent or repeat callers for the same key
 * share one promise (in-flight dedupe, and the resolved value afterwards). A failed load isn't
 * cached, so the next hover retries it.
 *
 * Invalidated per repo on `repoChanged`/`refsUpdated` (a push, fetch or prune can change what it
 * reports) — subscribed lazily, on the first call, so importing this module never opens a
 * connection by itself.
 */
const cache = new Map<string, Promise<LastPushPayload | null>>();
const key = (repo: number, remoteRef: string) => `${repo}\u0000${remoteRef}`;

let subscribed = false;
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  onEvent((ev) => {
    if (ev.type !== 'repoChanged' && ev.type !== 'refsUpdated') return;
    const prefix = `${ev.repo}\u0000`;
    for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
  });
}

export function getLastPush(repo: number, remoteRef: string): Promise<LastPushPayload | null> {
  ensureSubscribed();
  const k = key(repo, remoteRef);
  const hit = cache.get(k);
  if (hit) return hit;
  const promise = api.lastPush(repo, remoteRef).catch((e: unknown) => {
    cache.delete(k); // never cache a failure: the next hover retries it
    throw e;
  });
  cache.set(k, promise);
  return promise;
}
