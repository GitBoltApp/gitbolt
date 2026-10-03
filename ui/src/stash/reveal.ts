import { useRuntime } from '../app/runtime';
import { tabStore } from '../app/tabStores';
import { displayedOrder } from '../files/fileListPrefs';
import { filesKey } from '../repo/services';
import type { DiffTarget, RepoViewState, RepoViewStore } from '../repo/store';

/** How long the reveal waits for the refreshed graph to show the worktree's WIP row before it
 * asks for a refresh itself, and then gives up. */
export const WIP_WAIT_MS = 3000;

/** Resolves once `ok(state)` holds (checked now, then on every store change), or with false after
 * `ms`. */
function until(store: RepoViewStore, ok: (s: RepoViewState) => boolean, ms: number): Promise<boolean> {
  if (ok(store.getState())) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => { clearTimeout(timer); off(); resolve(v); };
    const off = store.subscribe((s) => { if (ok(s)) done(true); });
    const timer = setTimeout(() => done(false), ms);
  });
}

const wipIndexOf = (s: RepoViewState, worktree: string) => s.graph.rows.findIndex((r) => r.kind === 'wip' && r.wip?.worktreePath === worktree);

/**
 * The paths a stash holds (its commit's file list against its first parent), asked for before the
 * stash is applied: a Pop deletes the stash, but its commit's list is immutable and cached.
 * Null when it can't be read (the reveal then opens the WIP's first file).
 */
export function stashPaths(tabId: string, oid: string | null): Promise<ReadonlySet<string> | null> {
  const services = tabStore(tabId)?.getState().services;
  if (!services || !oid) return Promise.resolve(null);
  return services.files.get(filesKey({ kind: 'commit', id: oid, parent: 0 })).then((l) => new Set(l.files.map((f) => f.path)), () => null);
}

/**
 * After a stash Apply or Pop (the toolbar's Pop, the sidebar's and graph's Apply and Pop, a kept
 * stash's Apply; UX round 2): "now look at what came back". The worktree's WIP row is selected
 * (the refreshed graph shows it once the watcher's refresh lands), and `open` also opens the diff
 * of the first file the stash brought back, in the WIP lists' displayed order (the first WIP file
 * when `paths` is unknown or matches none), with the keyboard in the file list.
 *
 * Ruling: the diff opens whatever was open before, even with several files restored: the user's
 * own words were "select the WIP and show the diff panel". A selection the user changes while
 * the WIP lists load wins: nothing is opened over it.
 */
export async function revealRestored(tabId: string, worktree: string, paths: Promise<ReadonlySet<string> | null>, open = true): Promise<void> {
  const store = tabStore(tabId);
  if (!store) return;
  const hasWip = (s: RepoViewState) => wipIndexOf(s, worktree) >= 0;
  if (!(await until(store, hasWip, WIP_WAIT_MS))) {
    await useRuntime.getState().refresh(tabId, { graphOnly: true });
    if (!hasWip(store.getState())) return;
  }
  store.getState().selectRow(wipIndexOf(store.getState(), worktree));
  const selection = store.getState().selection;
  if (!open || selection.kind !== 'wip' || selection.worktree !== worktree) return;
  const known = await paths;
  const targetsOf = (s: RepoViewState): DiffTarget[] => s.sections.flatMap((sec) => (sec.list.status === 'ready' ? displayedOrder(sec.list.data.files, sec.spec) : []));
  // Loaded, and (a worktree that was already dirty keeps showing its old lists until the new ones
  // arrive) holding a file the stash brought back.
  const settled = (s: RepoViewState) => s.selection !== selection
    || (s.sections.every((sec) => sec.list.status !== 'loading') && (!known || targetsOf(s).some((t) => known.has(t.path))));
  await until(store, settled, WIP_WAIT_MS);
  const s = store.getState();
  if (s.selection !== selection || s.diff) return;
  const targets = targetsOf(s);
  const i = Math.max(0, known ? targets.findIndex((t) => known.has(t.path)) : 0);
  if (!targets[i]) return;
  s.openFile(targets[i], targets.slice(i + 1, i + 2));
  s.setFocus('files');
}
