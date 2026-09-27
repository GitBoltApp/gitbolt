/** A least-recently-used cache bounded by entry count and, optionally, total size (spec §4.4). */
export class Lru<K, V> {
  readonly maxEntries: number;
  readonly maxBytes: number;
  private readonly sizeOf: (v: V) => number;
  private readonly map = new Map<K, { value: V; size: number }>(); // insertion order = recency
  private total = 0;

  constructor(maxEntries: number, maxBytes = Number.POSITIVE_INFINITY, sizeOf: (v: V) => number = () => 0) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
  }

  get size(): number { return this.map.size; }
  get bytes(): number { return this.total; }
  has(key: K): boolean { return this.map.has(key); }
  /** The cached value, without refreshing its recency. */
  peek(key: K): V | undefined { return this.map.get(key)?.value; }

  /** The cached value, marking it most recently used. */
  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    const size = this.sizeOf(value);
    this.map.set(key, { value, size });
    this.total += size;
    for (const [k] of this.map) {
      if (this.map.size <= this.maxEntries && this.total <= this.maxBytes) break;
      if (k === key) break; // only the newest entry is left: a single oversize entry is kept
      this.delete(k);
    }
  }

  delete(key: K): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    this.total -= e.size;
    this.map.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}
