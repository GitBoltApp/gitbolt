import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileListPayload } from '../api/gen/FileListPayload';

export type WipSpec = Extract<DiffSpec, { kind: 'wip' }>;

/** A WIP list's key: `filesKey` of its spec (same field order as the store's `sectionSpecs`). */
export const wipKey = (worktree: string, staged: boolean) => JSON.stringify({ kind: 'wip', worktree, staged } satisfies WipSpec);

/**
 * The WIP rows' file lists, held in memory while the tab is watched (K44), so selecting a WIP
 * row renders at once with no request. The backend's watcher keeps each watched worktree's lists
 * current and stamps them with a `version`; a `repoChanged` naming a worktree carries its new
 * version, and drops what's held for it unless that's already the version held.
 *
 * Only lists that came with a `version` (a trusted watcher's) are held, and only when no change
 * to that worktree was announced, nor the watch stopped, while they were in flight: a list
 * read before a change is never kept after it. Unwatched (an inactive tab, before its watch is
 * up, or a degraded watcher, whose lists carry no version), every `get` reads anew, as before.
 *
 * A worktree whose list or `repoChanged` came without a version (its watch is degraded) isn't
 * read ahead either, until an event brings a version again: those reads would only be thrown
 * away, and on a big repo each one is a full status and numstat.
 */
export class WipLists {
  private watched = false;
  /** Bumped when the watch stops: every load in flight then is too old to hold. */
  private epoch = 0;
  /** Per worktree: bumped by each change announced for it. */
  private readonly gens = new Map<string, number>();
  /** Worktrees whose last list or event had no version: not read ahead. */
  private readonly unversioned = new Set<string>();
  private readonly held = new Map<string, FileListPayload>();
  private readonly inflight = new Map<string, Promise<FileListPayload>>();
  private readonly listeners = new Set<(worktrees: ReadonlySet<string>) => void>();
  private readonly fetcher: (spec: WipSpec) => Promise<FileListPayload>;

  constructor(fetcher: (spec: WipSpec) => Promise<FileListPayload>) {
    this.fetcher = fetcher;
  }

  peek(key: string): FileListPayload | undefined {
    return this.held.get(key);
  }

  get(key: string): Promise<FileListPayload> {
    const hit = this.held.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const spec = JSON.parse(key) as WipSpec;
    const stamp = this.stamp(spec.worktree);
    // A read stays joinable until the current task ends, so whatever its result sets off (the
    // next section of `openFirstFile`) joins it rather than reading again.
    const done = () => setTimeout(() => { if (this.inflight.get(key) === p) this.inflight.delete(key); }, 0);
    // Sent before `get` returns, like a `Loader`'s.
    let req: Promise<FileListPayload>;
    try {
      req = this.fetcher(spec);
    } catch (e) {
      req = Promise.reject(e);
    }
    const p: Promise<FileListPayload> = req.then((list) => {
      done();
      if (this.watched && this.stamp(spec.worktree) === stamp) {
        if (list.version !== undefined) this.held.set(key, list);
        else this.unversioned.add(spec.worktree);
      }
      return list;
    }, (e: unknown) => {
      done();
      throw e;
    });
    this.inflight.set(key, p);
    return p;
  }

  /** Loads both lists of each of `worktrees` not held or loading, while watched. */
  prefetch(worktrees: readonly string[]): void {
    if (!this.watched) return;
    for (const wt of worktrees) {
      if (this.unversioned.has(wt)) continue;
      for (const staged of [false, true]) {
        const key = wipKey(wt, staged);
        if (!this.held.has(key) && !this.inflight.has(key)) this.get(key).catch(() => {});
      }
    }
  }

  /** The tab's watch started (once ready) or stopped. Either way it starts afresh: stopping
   * drops everything held, and nothing read before a change of watch is held after it. */
  setWatched(on: boolean): void {
    if (on === this.watched) return;
    this.watched = on;
    this.epoch++;
    this.held.clear();
    this.inflight.clear();
    this.unversioned.clear();
  }

  isWatched(): boolean {
    return this.watched;
  }

  /** A `repoChanged`: drops what's held for each of `worktrees` unless it's already at the
   * announced version, and tells the listeners which worktrees' lists changed. */
  changed(worktrees: readonly string[], versions: Readonly<Record<string, string>> = {}): void {
    const hit = new Set<string>();
    for (const wt of worktrees) {
      const v = versions[wt];
      if (v === undefined) this.unversioned.add(wt);
      else this.unversioned.delete(wt);
      const keys = [wipKey(wt, false), wipKey(wt, true)];
      if (v !== undefined && keys.every((k) => this.held.get(k)?.version === v)) continue;
      this.gens.set(wt, (this.gens.get(wt) ?? 0) + 1);
      for (const k of keys) {
        this.held.delete(k);
        this.inflight.delete(k);
      }
      hit.add(wt);
    }
    if (hit.size > 0) for (const l of this.listeners) l(hit);
  }

  /** A write's fresh lists (spec #2 §3.1): held at once, so the panel never waits on the
   * watcher. The write's `repoChanged` at the same version then keeps them. Reads in flight
   * from before the write are too old to hold. */
  put(worktree: string, lists: { staged: FileListPayload; unstaged: FileListPayload; version: string }): void {
    this.gens.set(worktree, (this.gens.get(worktree) ?? 0) + 1);
    const [unstaged, staged] = [wipKey(worktree, false), wipKey(worktree, true)];
    this.inflight.delete(unstaged);
    this.inflight.delete(staged);
    if (this.watched) {
      this.unversioned.delete(worktree);
      this.held.set(unstaged, { ...lists.unstaged, version: lists.version });
      this.held.set(staged, { ...lists.staged, version: lists.version });
    } else {
      this.held.delete(unstaged);
      this.held.delete(staged);
    }
    for (const l of this.listeners) l(new Set([worktree]));
  }

  /** Called with the worktrees whose lists `changed` or `put` replaced. Returns the unsubscribe. */
  subscribe(listener: (worktrees: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private stamp(worktree: string): string {
    return `${this.epoch}:${this.gens.get(worktree) ?? 0}`;
  }
}
