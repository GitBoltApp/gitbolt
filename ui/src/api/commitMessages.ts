import type { CommitMessage } from './gen/CommitMessage';

/**
 * Full commit messages, loaded on demand (`commitMessage` request) and kept in a small LRU keyed
 * by commit id. The graph payload carries only each row's summary and body's first line; the
 * full-message tooltip (§8.4) and, from plan 1B, the details panel read full messages through
 * this cache. Concurrent requests for the same id share one load; failures aren't cached.
 */
export interface CommitMessageCache {
  readonly capacity: number;
  /** The cached message, if any (and marks it recently used). */
  peek(id: string): CommitMessage | undefined;
  get(id: string): Promise<CommitMessage>;
}

export function createCommitMessageCache(load: (id: string) => Promise<CommitMessage>, capacity = 200): CommitMessageCache {
  const entries = new Map<string, CommitMessage>(); // insertion order = recency order
  const inflight = new Map<string, Promise<CommitMessage>>();
  const peek = (id: string) => {
    const m = entries.get(id);
    if (m) {
      entries.delete(id);
      entries.set(id, m);
    }
    return m;
  };
  return {
    capacity,
    peek,
    get(id) {
      const hit = peek(id);
      if (hit) return Promise.resolve(hit);
      const pending = inflight.get(id);
      if (pending) return pending;
      const p = load(id).then(
        (m) => {
          inflight.delete(id);
          entries.set(id, m);
          while (entries.size > capacity) entries.delete(entries.keys().next().value!);
          return m;
        },
        (e: unknown) => {
          inflight.delete(id);
          throw e;
        },
      );
      inflight.set(id, p);
      return p;
    },
  };
}
