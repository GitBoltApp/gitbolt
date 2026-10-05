import { create } from 'zustand';

/**
 * Spec #5 §3.4: one navigation history per repository tab, a list of places (at most
 * MAX_PLACES) and a cursor. Mouse back/forward, Alt+←/→ and the palette's Go back / Go forward
 * step through it (`input.ts`). Each place kind registers how to save its scroll and how to show
 * it again (`mrPlaces.ts`, `repoPlaces.ts`); a place that can't be shown any more is dropped and
 * the step goes on past it.
 */
export type FileCommit = string | 'worktree';
export type PlaceView = 'rendered' | 'source';
/** A long rendered Markdown document's reading position: its `block`-th top-level block (across
 * its chunks), scrolled `offset` px past that block's top. */
export interface BlockPos { block: number; offset: number }
export type Place =
  | { kind: 'mr'; number: number; scrollTop: number }
  /** `block`: where a long rendered document was read (`scrollTop` is its fallback). */
  | { kind: 'file'; path: string; commit: FileCommit; view: PlaceView; scrollTop: number; block?: BlockPos }
  | { kind: 'commit'; sha: string };
export type PlaceKindName = Place['kind'];
type PlaceOf<K extends PlaceKindName> = Extract<Place, { kind: K }>;

export interface NavHistory { places: readonly Place[]; cursor: number }
export const MAX_PLACES = 50;
export const EMPTY_HISTORY: NavHistory = { places: [], cursor: -1 };

/** A place's identity: two arrivals with the same key are the same place. */
export function placeKey(p: Place): string {
  switch (p.kind) {
    case 'mr': return `mr:${p.number}`;
    case 'file': return `file:${p.commit}:${p.path}`;
    case 'commit': return `commit:${p.sha}`;
  }
}

/**
 * `h` after arriving at `place`. The place already current: `h` itself. Otherwise the forward
 * entries go; `replace` swaps the current place when it's of the same kind (stepping through a
 * list), else it adds one like `push`. The oldest places go past MAX_PLACES.
 */
export function arrive(h: NavHistory, place: Place, how: 'push' | 'replace' = 'push'): NavHistory {
  const cur = h.places[h.cursor];
  if (cur && placeKey(cur) === placeKey(place)) return h;
  const kept = h.places.slice(0, h.cursor + 1);
  if (how === 'replace' && cur && cur.kind === place.kind) kept[kept.length - 1] = place;
  else kept.push(place);
  const places = kept.slice(-MAX_PLACES);
  return { places, cursor: places.length - 1 };
}

/** The cursor moved one place back (-1) or forward (1); `null` at that end. */
export function step(h: NavHistory, dir: -1 | 1): NavHistory | null {
  const cursor = h.cursor + dir;
  return cursor >= 0 && cursor < h.places.length ? { places: h.places, cursor } : null;
}

/** Without place `i`, which a step in `dir` reached and found gone: the cursor goes back on the
 * place the step came from, so the next step in `dir` goes past `i`. */
export function dropAt(h: NavHistory, i: number, dir: -1 | 1): NavHistory {
  const places = h.places.filter((_, j) => j !== i);
  const cursor = dir < 0 ? i : i - 1;
  return { places, cursor: Math.min(places.length - 1, Math.max(-1, cursor)) };
}

const withCurrent = (h: NavHistory, p: Place): NavHistory =>
  h.cursor < 0 ? h : { places: h.places.map((x, i) => (i === h.cursor ? p : x)), cursor: h.cursor };

export const useNavHistory = create<{ byTab: Record<string, NavHistory> }>(() => ({ byTab: {} }));
export const historyOf = (tabId: string): NavHistory => useNavHistory.getState().byTab[tabId] ?? EMPTY_HISTORY;
const put = (tabId: string, h: NavHistory) =>
  useNavHistory.setState((s) => (s.byTab[tabId] === h ? s : { byTab: { ...s.byTab, [tabId]: h } }));
export const canGoBack = (tabId: string) => historyOf(tabId).cursor > 0;
export const canGoForward = (tabId: string) => {
  const h = historyOf(tabId);
  return h.cursor < h.places.length - 1;
};

/** The tab closed or moved to another repository: its places go. */
export function dropHistory(tabId: string): void {
  seqs.delete(tabId);
  if (!(tabId in useNavHistory.getState().byTab)) return;
  useNavHistory.setState((s) => {
    const byTab = { ...s.byTab };
    delete byTab[tabId];
    return { byTab };
  });
}

/**
 * A kind of place. `capture`: the place as it is now (its scroll position, File View's view),
 * or `null` to keep it as recorded. `restore`: shows it again; `false` when it's gone (the kind
 * has already said why, in a toast). A restore may open its place through the usual paths
 * (`openMrView`, `openFile`): the arrival they record is the current place, so it adds nothing.
 * `arrivesItself`: the history's cursor moves onto the place only when `restore` calls `arrive`
 * (File View: once leaving the open file is settled, so a cancelled leave prompt moves nothing);
 * otherwise it moves before `restore` runs.
 */
export interface PlaceKind<K extends PlaceKindName> {
  capture?(tabId: string, place: PlaceOf<K>): PlaceOf<K> | null;
  restore(tabId: string, place: PlaceOf<K>, arrive: () => void): Promise<boolean>;
  arrivesItself?: boolean;
}
const kinds = new Map<PlaceKindName, PlaceKind<PlaceKindName>>();

export function registerPlaceKind<K extends PlaceKindName>(kind: K, def: PlaceKind<K>): () => void {
  const entry = def as unknown as PlaceKind<PlaceKindName>;
  kinds.set(kind, entry);
  return () => {
    if (kinds.get(kind) === entry) kinds.delete(kind);
  };
}

/** `h` with its current place captured as it is now. */
function captured(tabId: string, h: NavHistory): NavHistory {
  const cur = h.places[h.cursor];
  const now = cur ? kinds.get(cur.kind)?.capture?.(tabId, cur as PlaceOf<PlaceKindName>) : null;
  return now ? withCurrent(h, now) : h;
}

/** Per tab: bumped by every arrival and step, so a restore still loading knows it was overtaken. */
const seqs = new Map<string, number>();
const bump = (tabId: string) => {
  const n = (seqs.get(tabId) ?? 0) + 1;
  seqs.set(tabId, n);
  return n;
};

/** An arrival (spec #5 §3.4): the place being left saves its scroll first. */
export function recordPlace(tabId: string, place: Place, how: 'push' | 'replace' = 'push'): void {
  const h = historyOf(tabId);
  const cur = h.places[h.cursor];
  if (cur && placeKey(cur) === placeKey(place)) return;
  bump(tabId);
  put(tabId, arrive(captured(tabId, h), place, how));
}

async function go(tabId: string, dir: -1 | 1): Promise<void> {
  const mine = bump(tabId);
  let h = captured(tabId, historyOf(tabId));
  for (;;) {
    const next = step(h, dir);
    const place = next?.places[next.cursor];
    const kind = place ? kinds.get(place.kind) : undefined;
    put(tabId, next && !kind?.arrivesItself ? next : h);
    if (!next || !place) return;
    // A step overtaken meanwhile (a newer step or arrival) doesn't move the cursor any more.
    const arrive = () => { if (seqs.get(tabId) === mine) put(tabId, next); };
    const ok = kind ? await kind.restore(tabId, place as PlaceOf<PlaceKindName>, arrive).catch(() => false) : false;
    if (seqs.get(tabId) !== mine) return;
    if (ok) return;
    h = dropAt(historyOf(tabId), next.cursor, dir);
  }
}

export const navBack = (tabId: string): Promise<void> => go(tabId, -1);
export const navForward = (tabId: string): Promise<void> => go(tabId, 1);
