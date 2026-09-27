import type { Lru } from './lru';

export type Priority = 'now' | 'prefetch';

/** The rejection of a prefetch that was replaced before it started. It's never shown. */
export class DroppedError extends Error {
  constructor() {
    super('superseded prefetch');
    this.name = 'DroppedError';
  }
}

interface Job<V> { key: string; priority: Priority; resolve: (v: V) => void; reject: (e: unknown) => void }

/**
 * Keyed, cached, de-duplicated async loads with a concurrency limit (spec §11.1 prefetching).
 * `get` jumps the queue, and `prefetch` replaces the pending prefetch queue, so prefetches the
 * user has moved past are dropped before they're sent. Failed loads are never cached.
 *
 * In-flight reads aren't cancelled (plan 1B deviation 2): a started load always completes and
 * is cached; callers ignore results for selections they've left (the store's sequence number).
 *
 * The fetcher runs synchronously inside `get`/`prefetch` whenever a slot is free, so a request
 * is sent before `get` returns; a fetcher that throws synchronously rejects that load.
 */
export class Loader<V> {
  readonly cache: Lru<string, V>;
  private readonly fetcher: (key: string) => Promise<V>;
  private readonly concurrency: number;
  private readonly cacheable: (key: string) => boolean;
  private readonly inflight = new Map<string, Promise<V>>();
  private queue: Job<V>[] = [];
  private running = 0;

  constructor(fetcher: (key: string) => Promise<V>, cache: Lru<string, V>, concurrency = 4, cacheable: (key: string) => boolean = () => true) {
    this.fetcher = fetcher;
    this.cache = cache;
    this.concurrency = concurrency;
    this.cacheable = cacheable;
  }

  /** The cached value, if any (a hit counts as a use: it refreshes recency); never starts a load. */
  peek(key: string): V | undefined {
    return this.cache.get(key);
  }

  get(key: string, priority: Priority = 'now'): Promise<V> {
    const hit = this.cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending) {
      if (priority === 'now') this.promote(key);
      return pending;
    }
    const promise = new Promise<V>((resolve, reject) => {
      const job: Job<V> = { key, priority, resolve, reject };
      if (priority === 'now') this.queue.unshift(job);
      else this.queue.push(job);
    });
    this.inflight.set(key, promise);
    this.pump();
    return promise;
  }

  /** Replaces every queued (not yet started) prefetch with `keys`. */
  prefetch(keys: string[]): void {
    const wanted = new Set(keys);
    const dropped = this.queue.filter((j) => j.priority === 'prefetch' && !wanted.has(j.key));
    if (dropped.length > 0) {
      const gone = new Set(dropped);
      this.queue = this.queue.filter((j) => !gone.has(j));
      for (const j of dropped) {
        this.inflight.delete(j.key);
        j.reject(new DroppedError());
      }
    }
    for (const k of keys) {
      if (!this.cache.has(k) && !this.inflight.has(k)) this.get(k, 'prefetch').catch(() => {});
    }
  }

  private promote(key: string): void {
    const i = this.queue.findIndex((j) => j.key === key);
    if (i < 0) return;
    const [job] = this.queue.splice(i, 1);
    job.priority = 'now';
    this.queue.unshift(job);
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      let p: Promise<V>;
      try {
        p = Promise.resolve(this.fetcher(job.key));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (v) => {
          if (this.cacheable(job.key)) this.cache.set(job.key, v);
          job.resolve(v);
        },
        (e: unknown) => job.reject(e),
      ).finally(() => {
        this.inflight.delete(job.key);
        this.running--;
        this.pump();
      });
    }
  }
}
