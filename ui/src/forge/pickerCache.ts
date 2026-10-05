import { onForgeAccountsChanged } from './accountsBus';

/**
 * Memory-only cache for the + Add pickers (reviewers, assignees, labels). Keyed by tab repo +
 * remote + kind + query, so a result never shows for another project. An entry older than
 * STALE_MS still shows at once and is refreshed in the background. Cleared when a forge account
 * changes (the project may now resolve differently); a main-remote change lands on other keys.
 */
export const STALE_MS = 5 * 60_000;

interface Entry { at: number; value: unknown }
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
let epoch = 0;

export function clearPickerCache(): void {
  store.clear();
  inflight.clear();
  epoch++;
}
onForgeAccountsChanged(clearPickerCache);

const keyOf = (repo: number, remote: string, kind: string, query: string) => `${repo}\u0000${remote}\u0000${kind}\u0000${query}`;
const norm = (q: string) => q.trim();

function peekRaw<T>(key: string): { items: T[]; stale: boolean } | undefined {
  const e = store.get(key);
  return e ? { items: e.value as T[], stale: Date.now() - e.at > STALE_MS } : undefined;
}

/** One request per key at a time; a result that lands after a clear is returned but not kept. */
function loadRaw<T>(key: string, fetch: () => Promise<T[]>): Promise<T[]> {
  const running = inflight.get(key);
  if (running) return running as Promise<T[]>;
  const mine = epoch;
  const p: Promise<T[]> = fetch().then((v) => {
    if (mine === epoch) store.set(key, { at: Date.now(), value: v });
    return v;
  }).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

export interface PickerSource<T> {
  /** What the cache holds for `query` right now (no request); `stale` means refresh it. */
  peek(query: string): { items: T[]; stale: boolean } | undefined;
  load(query: string): Promise<T[]>;
}

/** People: the empty query (suggested people) and each query cached on its own. */
export function peopleSource<T>(repo: number, remote: string, fetch: (q: string) => Promise<T[]>): PickerSource<T> {
  return {
    peek: (q) => peekRaw<T>(keyOf(repo, remote, 'people', norm(q))),
    load: (q) => loadRaw(keyOf(repo, remote, 'people', norm(q)), () => fetch(norm(q))),
  };
}

/** GitHub lists up to 3 pages of 100 labels, GitLab one page of 50. */
export const labelListLimit = (kind: string | null | undefined): number => (kind === 'github' ? 300 : 50);

/**
 * Labels: the empty query returns the project's labels, so fetch that once and filter locally,
 * unless the list reached the provider's limit (it may be truncated): then each query goes to the
 * server and is cached by itself.
 */
export function labelsSource<T extends { name: string }>(repo: number, remote: string, limit: number, fetch: (q: string) => Promise<T[]>): PickerSource<T> {
  const all = keyOf(repo, remote, 'labels', '');
  const filter = (items: T[], q: string) => { const n = norm(q).toLowerCase(); return n ? items.filter((l) => l.name.toLowerCase().includes(n)) : items; };
  const complete = (items: T[]) => items.length < limit;
  return {
    peek(q) {
      const list = peekRaw<T>(all);
      if (list && complete(list.items)) return { items: filter(list.items, q), stale: list.stale };
      if (!norm(q)) return list;
      return peekRaw<T>(keyOf(repo, remote, 'labels', norm(q)));
    },
    async load(q) {
      const list = await loadRaw(all, () => fetch(''));
      if (complete(list)) return filter(list, q);
      if (!norm(q)) return list;
      return loadRaw(keyOf(repo, remote, 'labels', norm(q)), () => fetch(norm(q)));
    },
  };
}

/** Maps a source's items to options (the closures in `value` can't be cached, so they are rebuilt per call). */
export function mapSource<T, O>(src: PickerSource<T>, map: (t: T) => O) {
  return {
    search: (q: string) => src.load(q).then((l) => l.map(map)),
    peek: (q: string) => { const h = src.peek(q); return h && { options: h.items.map(map), stale: h.stale }; },
  };
}
