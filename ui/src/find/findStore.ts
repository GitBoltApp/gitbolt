import { create } from 'zustand';
import { api } from '../api/client';
import type { HistoryHit } from '../api/gen/HistoryHit';
import { selectCommit } from '../app/graphNav';
import { useRuntime } from '../app/runtime';
import { tabStore, tabView } from '../app/tabStores';

/**
 * Find in the graph (Ctrl+F, spec §8.7), per tab. One query matches a commit's message
 * (case-insensitive substring), its SHA (a prefix, for 4+ hex characters) and, from 2
 * characters, the paths it touched (the backend's lazily built path index). The non-matches dim
 * through the shared row-dim (the tab store's `filterKeep`, rowDim.ts 'filter' level); nothing is
 * hidden.
 */
export interface FindState {
  open: boolean;
  query: string;
  /** Matching commit ids, in graph order. */
  matches: string[];
  /** The current match (`matches[index]`, the selected row); -1 for none. */
  index: number;
  /** The path search is still running: its matches merge in when it answers. */
  pathPending: boolean;
  /** "Search older history"'s hits, once asked; `null` until then (or after a new query). */
  older: HistoryHit[] | null;
  olderLoading: boolean;
  message: string | null;
  /** Bumped by every `openFind`: the box focuses (and selects) its input on each bump. */
  focusRequest: number;
}

const CLOSED: FindState = { open: false, query: '', matches: [], index: -1, pathPending: false, older: null, olderLoading: false, message: null, focusRequest: 0 };
/** Spec §8.7 / plan constants. */
export const DEBOUNCE_MS = 50;
export const PATH_MIN_CHARS = 2;
const FULL_HASH = /^([0-9a-f]{40}|[0-9a-f]{64})$/i;

export const useFind = create<{ byTab: Record<string, FindState> }>(() => ({ byTab: {} }));

const get = (tabId: string) => useFind.getState().byTab[tabId] ?? CLOSED;
const patch = (tabId: string, p: Partial<FindState>) => useFind.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...(s.byTab[tabId] ?? CLOSED), ...p } } }));
/** Bumped per query (and on close): an answer for an older one is dropped. */
const seqs = new Map<string, number>();
const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
/** Cancels the tab's debouncing query, if any: its promise resolves (it searches nothing). */
function cancelPending(tabId: string): void {
  const p = timers.get(tabId);
  if (!p) return;
  timers.delete(tabId);
  clearTimeout(p.timer);
  p.resolve();
}
/** Tabs whose typed query is still debouncing or running (its own search covers the new graph). */
const typing = new Set<string>();
const bump = (tabId: string) => {
  const seq = (seqs.get(tabId) ?? 0) + 1;
  seqs.set(tabId, seq);
  return seq;
};

/** Opens the tab's find box (or, already open, focuses it again). */
export function openFind(tabId: string): void {
  const cur = get(tabId);
  patch(tabId, { open: true, focusRequest: cur.focusRequest + 1 });
}

/** Closes and clears (spec §8.7: "Esc closes and clears"): the dimming goes with the query. */
export function closeFind(tabId: string): void {
  cancelPending(tabId);
  typing.delete(tabId);
  bump(tabId);
  const focusRequest = get(tabId).focusRequest;
  useFind.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...CLOSED, focusRequest } } }));
  tabStore(tabId)?.getState().setFilterKeep(null);
}

/** `ids` in the tab's graph order (one pass over the rows). */
function ordered(tabId: string, ids: Iterable<string>): string[] {
  const rows = tabStore(tabId)?.getState().graph.rows ?? [];
  const want = new Set(ids);
  return rows.filter((r) => want.has(r.id)).map((r) => r.id);
}

/**
 * Shows `matches`: the current match stays current if it's still one; otherwise the first match
 * becomes current and, when `select`, is selected (scrolled to). Their dimming goes to the store.
 */
function show(tabId: string, matches: string[], select: boolean): void {
  const cur = get(tabId);
  const was = cur.index >= 0 ? cur.matches[cur.index] : undefined;
  const keep = was === undefined ? -1 : matches.indexOf(was);
  const index = matches.length ? (keep >= 0 ? keep : 0) : -1;
  patch(tabId, { matches, index });
  tabStore(tabId)?.getState().setFilterKeep(new Set(matches));
  if (select && index >= 0 && index !== keep) selectCommit(tabId, matches[index]);
}

/** Spec §8.7: message and SHA as you type (debounced 50 ms), paths once the index answers. */
export function setFindQuery(tabId: string, query: string, debounceMs = DEBOUNCE_MS): Promise<void> {
  patch(tabId, { query, older: null, olderLoading: false, message: null });
  cancelPending(tabId);
  const seq = bump(tabId);
  typing.add(tabId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(tabId);
      void run(tabId, query.trim(), seq, true).finally(() => {
        if (seqs.get(tabId) === seq) typing.delete(tabId);
        resolve();
      });
    }, debounceMs);
    timers.set(tabId, { timer, resolve });
  });
}

/** Re-runs the open query against a new graph window (a refresh): the matches follow it, and
 * the selection stays where it is. Not while a typed query is still on its way: that one
 * searches the new window itself (and may be what loaded it: a hash outside the window). */
export function rerunFind(tabId: string): Promise<void> {
  const s = get(tabId);
  if (!s.open || !s.query.trim() || typing.has(tabId)) return Promise.resolve();
  return run(tabId, s.query.trim(), bump(tabId), false);
}

async function run(tabId: string, q: string, seq: number, select: boolean): Promise<void> {
  const repo = tabView(tabId)?.repo;
  const live = () => seqs.get(tabId) === seq;
  if (repo === undefined || !q) {
    if (live()) {
      patch(tabId, { matches: [], index: -1, pathPending: false });
      tabStore(tabId)?.getState().setFilterKeep(null);
    }
    return;
  }
  try {
    const text = await api.findText(repo, q);
    if (!live()) return;
    show(tabId, ordered(tabId, text), select);
    if ([...q].length >= PATH_MIN_CHARS) {
      patch(tabId, { pathPending: true });
      const paths = await api.findPaths(repo, q).finally(() => { if (live()) patch(tabId, { pathPending: false }); });
      if (!live()) return;
      show(tabId, ordered(tabId, [...text, ...paths]), select);
    }
    // A full hash that isn't in the window (spec §8.7): load commits until it appears, up to 10k.
    // Even when other matches exist (a revert's message naming it): the commit itself is the
    // one asked for. Loaded, its own SHA would have matched.
    const sha = q.toLowerCase();
    if (select && FULL_HASH.test(q) && !get(tabId).matches.includes(sha)) {
      const loc = await api.locateCommit(repo, q).catch(() => null);
      if (!live()) return;
      if (!loc?.found || !loc.limit) {
        patch(tabId, { message: 'Not in the loaded history' });
        return;
      }
      if (!(await deepen(tabId, loc.limit, live))) return;
      const again = await api.findText(repo, q);
      if (!live()) return;
      const matches = ordered(tabId, [...again, sha]);
      const index = matches.indexOf(sha);
      patch(tabId, { matches, index });
      tabStore(tabId)?.getState().setFilterKeep(new Set(matches));
      if (index >= 0) selectCommit(tabId, sha);
    }
  } catch (e) {
    if (live()) patch(tabId, { pathPending: false, message: `Search failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}

/** Loads a commit window of `limit` (the tab's override, spec §8.7); false if superseded. */
async function deepen(tabId: string, limit: number, live: () => boolean = () => true): Promise<boolean> {
  useRuntime.getState().patch(tabId, { limit });
  await useRuntime.getState().refresh(tabId);
  return live();
}

export function stepFind(tabId: string, delta: 1 | -1): void {
  const s = get(tabId);
  if (!s.matches.length) return;
  const index = (s.index + delta + s.matches.length) % s.matches.length;
  patch(tabId, { index });
  selectCommit(tabId, s.matches[index]);
}

/** Spec §8.7 "Search older history": commits outside the window. */
export async function searchOlder(tabId: string): Promise<void> {
  const repo = tabView(tabId)?.repo;
  const q = get(tabId).query.trim();
  if (repo === undefined || !q) return;
  const seq = seqs.get(tabId);
  patch(tabId, { olderLoading: true });
  const older = await api.searchHistory(repo, q).catch(() => []);
  if (seqs.get(tabId) === seq) patch(tabId, { older, olderLoading: false });
}

/** An older hit: load a window deep enough to hold it (up to 10k commits), then select it. */
export async function revealOlder(tabId: string, sha: string): Promise<void> {
  const repo = tabView(tabId)?.repo;
  if (repo === undefined) return;
  const loc = await api.locateCommit(repo, sha).catch(() => null);
  if (loc?.found && loc.limit) await deepen(tabId, loc.limit);
  if (selectCommit(tabId, sha, { focus: true })) patch(tabId, { message: null });
  else patch(tabId, { message: 'Not in the loaded history (deeper than 10,000 commits)' });
}
