import type { WipLists } from '../../repo/wipLists';
import { readWorkingFile, type WorkingFile } from './applySuggestion';

/**
 * The working-copy files the suggestions' Apply buttons check, read once per generation of a
 * tab's worktree: every button on a file shares one read, and a WIP change (a save, an edit in
 * another program, an apply) starts a new generation once its burst settles (`REREAD_MS`: a
 * write's fresh lists and the watcher's echo of it are one re-read, not two). A read is keyed on
 * its generation, so one that answers late never stands for a newer one.
 */

/** How long a burst of WIP changes settles before the files are read again. */
export const REREAD_MS = 150;

interface Watch { gen: number; listeners: Set<() => void>; off: () => void; timer: ReturnType<typeof setTimeout> | undefined }

const watches = new Map<string, Watch>();
const reads = new Map<string, Promise<WorkingFile | null>>();
/** Generations are unique across watches: a watch made again never repeats an old one's. */
let lastGen = 0;
const watchKey = (tabId: string, worktree: string) => `${tabId}\u0000${worktree}`;

/** Drops the reads of `k` but those of generation `keep`. */
function drop(k: string, keep?: number): void {
  for (const key of [...reads.keys()]) if (key.startsWith(`${k}\u0000`) && (keep === undefined || !key.startsWith(`${k}\u0000${keep}\u0000`))) reads.delete(key);
}

function next(k: string, w: Watch): void {
  clearTimeout(w.timer);
  w.timer = undefined;
  w.gen = ++lastGen;
  drop(k, w.gen);
  for (const l of [...w.listeners]) l();
}

/** Calls `listener` at each new generation of the tab's `worktree` (its WIP lists from `wip`).
 * Returns the unsubscribe; the last one stops the watch. */
export function watchWorkingFiles(tabId: string, wip: Pick<WipLists, 'subscribe'>, worktree: string, listener: () => void): () => void {
  const k = watchKey(tabId, worktree);
  let w = watches.get(k);
  if (!w) {
    const made: Watch = { gen: ++lastGen, listeners: new Set(), off: () => {}, timer: undefined };
    made.off = wip.subscribe((wts) => {
      if (!wts.has(worktree)) return;
      clearTimeout(made.timer);
      made.timer = setTimeout(() => next(k, made), REREAD_MS);
    });
    watches.set(k, (w = made));
  }
  const watch = w;
  watch.listeners.add(listener);
  return () => {
    watch.listeners.delete(listener);
    if (watch.listeners.size > 0 || watches.get(k) !== watch) return;
    watch.off();
    clearTimeout(watch.timer);
    watches.delete(k);
    drop(k);
  };
}

/** The tab's worktree's current generation (0: not watched). */
export const workingGen = (tabId: string, worktree: string): number => watches.get(watchKey(tabId, worktree))?.gen ?? 0;

/** A new generation at once (this button's own write: no wait for the burst to settle). */
export function rereadNow(tabId: string, worktree: string): void {
  const k = watchKey(tabId, worktree);
  const w = watches.get(k);
  if (w) next(k, w);
}

/** The file at `path` as of the current generation: one read shared by every caller. */
export function readAtGen(tabId: string, repoId: number, worktree: string, path: string): Promise<WorkingFile | null> {
  const k = watchKey(tabId, worktree);
  const key = `${k}\u0000${workingGen(tabId, worktree)}\u0000${repoId}\u0000${path}`;
  let p = reads.get(key);
  if (!p) {
    p = readWorkingFile({ repoId, worktree }, path);
    // Unwatched (no generations): read each time, nothing held.
    if (watches.has(k)) reads.set(key, p);
  }
  return p;
}
