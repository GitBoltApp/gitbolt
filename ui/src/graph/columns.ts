import { create } from 'zustand';
import { SHORT_SHA_LEN } from '../format/sha';
import type { Metrics } from './geometry';

/** The graph table's columns, left to right: Branch/Tag · Graph · Message · Author · Date · SHA.
 * Every column but the last has a drag handle on its RIGHT edge (feedback F3); SHA's right edge is
 * the table's end. */
export type ResizableColumn = 'labels' | 'graph' | 'message' | 'author' | 'date';
/** The columns with a stored preference (Message flexes: it takes what is left over). */
export type PrefColumn = 'labels' | 'graph' | 'author' | 'date' | 'sha';

/** The SHA cell's monospace glyph (13 px ui-monospace, 1ch, measured in Chromium and WebKit) and
 * its 6 + 6 px padding (fixed at every density, graph.css): SHA ranges from the app-wide
 * SHORT_SHA_LEN hex characters (H15) to all 40. The cell shows whole characters only
 * (graph.css), so a wider column reveals more of the hash. */
const SHA_CH = 7.83;
const SHA_PAD = 12;
/** Room over the minimum's exact fit (6 × 7.83 + 12 leaves ~0.02 px): a slightly wider `ch`
 * under CEF, another font or a zoom level still shows all SHORT_SHA_LEN characters. */
const SHA_SLACK = 1;
/** Minimum widths, CSS px (Task 15). Message's minimum is where the smart fit starts squeezing
 * Author and Date. */
export const COLUMN_MIN = { labels: 80, graph: 48, author: 60, date: 90, message: 160, sha: Math.ceil(SHORT_SHA_LEN * SHA_CH + SHA_PAD) + SHA_SLACK } as const;
/** SHA's default width, its minimum: exactly SHORT_SHA_LEN characters, like everywhere else
 * (H15); and its maximum (the full 40-character hash). */
export const SHA_W = COLUMN_MIN.sha;
export const SHA_MAX = Math.ceil(40 * SHA_CH + SHA_PAD);

/** The user's preferred widths. `graph: null` means "fit the lanes" (autoGraphWidth). */
export interface ColumnPrefs { labels: number; graph: number | null; author: number; date: number; sha: number }
export const DEFAULT_COLUMN_PREFS: ColumnPrefs = { labels: 200, graph: null, author: 160, date: 170, sha: SHA_W };

export interface ColumnWidths { labels: number; graph: number; message: number; author: number; date: number; sha: number; total: number }

/** The width every lane of the graph needs, node padding included. Below it the graph is cut off
 * (the overflow strip shows, F2). */
export const lanesWidth = (maxLanes: number, m: Pick<Metrics, 'laneW' | 'padX'>) => maxLanes * m.laneW + 2 * m.padX;

/**
 * The graph column's width before the user resizes it, and its MAX width (F2): every lane plus
 * padding, at least 64 px. Uncapped by the window, so no lane (and no commit on it) is ever
 * clipped at the default width; a table wider than the window scrolls horizontally. Narrowing
 * the column by hand can clip lanes (the overflow strip marks it; the collapse zone is F11).
 */
export const autoGraphWidth = (maxLanes: number, m: Pick<Metrics, 'laneW' | 'padX'>) =>
  Math.max(64, lanesWidth(maxLanes, m));

const MIN_TOTAL = COLUMN_MIN.labels + COLUMN_MIN.graph + COLUMN_MIN.message + COLUMN_MIN.author + COLUMN_MIN.date + COLUMN_MIN.sha;

/** The widest Branch/Tag or Graph can be dragged in an `available`-px table: whatever is left
 * once every other column is at its minimum (never below the column's own minimum). */
export const columnMax = (col: 'labels' | 'graph', available: number) =>
  Math.max(COLUMN_MIN[col], available - (MIN_TOTAL - COLUMN_MIN[col]));

/** The columns that can be hidden, per repo (spec §8.4: every one but Graph and Message). */
export type HideableColumn = 'labels' | 'author' | 'date' | 'sha';
export const HIDEABLE_COLUMNS: readonly HideableColumn[] = ['labels', 'author', 'date', 'sha'];
const NONE_HIDDEN: ReadonlySet<HideableColumn> = new Set();

/** Spec §8.4: a column shrunk to its minimum shows an icon instead of its header text (and its
 * cells collapse: icon-only chips, the avatar only). SHA is a preference column: never collapsed. */
export function isCollapsed(col: 'labels' | 'graph' | 'message' | 'author' | 'date', width: number): boolean {
  return width <= COLUMN_MIN[col];
}

/** The column each handle trades width with (resizeColumn): Branch/Tag and Graph with the
 * flexing Message, which is never hidden. */
const TRADES_WITH: Record<ResizableColumn, HideableColumn | null> = { labels: null, graph: null, message: 'author', author: 'date', date: 'sha' };

/** Whether `col`'s right-edge handle is shown: only while that column and the one it trades with
 * are both shown. A hidden neighbour leaves the boundary without a handle (Message flexes). */
export const handleShown = (col: ResizableColumn, hidden: ReadonlySet<HideableColumn>): boolean =>
  !hidden.has(col as HideableColumn) && !hidden.has(TRADES_WITH[col] as HideableColumn);

/**
 * Smart fit (spec §8.4): turns preferred widths into the widths actually rendered for a table
 * `available` px wide. Pure, whole pixels in and out.
 * 1. Branch/Tag, Graph and SHA always get their width (clamped to their minimums; SHA also to
 *    SHA_MAX).
 * 2. Message takes whatever is left over, as long as that's at least its minimum; so widening
 *    the window only ever grows Message, and narrowing shrinks it first.
 * 3. Once Message is at its minimum, Author and Date shrink toward their minimums, each in
 *    proportion to its room above its minimum (so both reach their minimums together).
 * 4. Below the sum of the minimums, `total` exceeds `available` and the table scrolls.
 * `hidden` columns (spec §8.4) get width 0, give their space to Message and have no room to give
 * when squeezing.
 */
export function allocateColumns(prefs: { labels: number; graph: number; author: number; date: number; sha?: number }, available: number, hidden: ReadonlySet<HideableColumn> = NONE_HIDDEN): ColumnWidths {
  const labels = hidden.has('labels') ? 0 : Math.max(COLUMN_MIN.labels, prefs.labels);
  const graph = Math.max(COLUMN_MIN.graph, prefs.graph);
  const sha = hidden.has('sha') ? 0 : Math.min(SHA_MAX, Math.max(COLUMN_MIN.sha, prefs.sha ?? SHA_W));
  const hideA = hidden.has('author');
  const hideD = hidden.has('date');
  let author = hideA ? 0 : Math.max(COLUMN_MIN.author, prefs.author);
  let date = hideD ? 0 : Math.max(COLUMN_MIN.date, prefs.date);
  const leftover = available - (labels + graph + author + date + sha);
  if (leftover >= COLUMN_MIN.message) {
    return { labels, graph, message: leftover, author, date, sha, total: available };
  }
  const deficit = COLUMN_MIN.message - leftover;
  const roomA = hideA ? 0 : author - COLUMN_MIN.author;
  const roomD = hideD ? 0 : date - COLUMN_MIN.date;
  if (deficit >= roomA + roomD) {
    if (!hideA) author = COLUMN_MIN.author;
    if (!hideD) date = COLUMN_MIN.date;
  } else {
    const fromA = Math.round((deficit * roomA) / (roomA + roomD));
    author -= fromA;
    date -= deficit - fromA;
  }
  const message = COLUMN_MIN.message;
  return { labels, graph, message, author, date, sha, total: labels + graph + message + author + date + sha };
}

type PrefsPatch = Partial<Record<PrefColumn, number>>;

/**
 * The range a handle's column can be resized to from the rendered widths `w` (for aria-valuemin
 * and aria-valuemax): Branch/Tag and Graph up to columnMax (never below their current width, and
 * Graph never past `graphMax`, F2); Message and Author up to what their right-hand neighbour can
 * give before it hits its minimum.
 */
export function handleRange(col: ResizableColumn, w: ColumnWidths, available: number, graphMax = Infinity): { min: number; max: number } {
  if (col === 'labels') return { min: COLUMN_MIN.labels, max: Math.max(columnMax('labels', available), w.labels) };
  if (col === 'graph') return { min: COLUMN_MIN.graph, max: Math.min(Math.max(columnMax('graph', available), w.graph), Math.max(COLUMN_MIN.graph, graphMax)) };
  if (col === 'message') return { min: COLUMN_MIN.message, max: w.message + Math.max(0, w.author - COLUMN_MIN.author) };
  if (col === 'author') return { min: COLUMN_MIN.author, max: w.author + Math.max(0, w.date - COLUMN_MIN.date) };
  // Date trades with SHA, both of whose walls hold: SHA's minimum (Date's max) and SHA_MAX.
  return { min: Math.min(w.date, Math.max(COLUMN_MIN.date, w.date - (SHA_MAX - w.sha))), max: w.date + Math.max(0, w.sha - COLUMN_MIN.sha) };
}

/**
 * One resize gesture step (pure): the preference patch that moves `col`'s right-edge handle `dx`
 * px from where it was at gesture start (`start`, the rendered widths then). Positive `dx` is
 * rightward. The boundary under the pointer is the one that moves, 1:1, and the dragged column is
 * the one resized (F3), trading width with the column on its right until either hits a wall:
 * - Branch/Tag and Graph: with the flexing Message (the smart fit: once Message is at its minimum
 *   Author and Date give way), between their minimum and handleRange's max. A column already
 *   wider than columnMax (the window narrowed after it was widened) is never pulled back by a
 *   widening gesture.
 * - Message (its right edge is Author's left edge): with Author. Author's preference changes.
 * - Author (its right edge is Date's left edge): with Date.
 * - Date: with SHA, between SHA's minimum and SHA_MAX. SHA is last: no handle, no fallback.
 * Message and Author patches set Author and Date to what will be rendered, so no preference is
 * left above its rendered width (nothing jumps when the window widens again).
 */
export function resizeColumn(col: ResizableColumn, start: ColumnWidths, dx: number, available: number, graphMax = Infinity): PrefsPatch {
  dx = Math.round(dx);
  const { min, max } = handleRange(col, start, available, graphMax);
  const width = Math.min(max, Math.max(min, start[col] + dx));
  if (col === 'labels' || col === 'graph') return { [col]: width };
  const moved = width - start[col];
  if (col === 'message') return { author: start.author - moved, date: start.date };
  if (col === 'author') return { author: width, date: start.date - moved };
  return { author: start.author, date: width, sha: start.sha - moved };
}

/**
 * THE persistence seam for column widths, keyed by repo (`repoId`: a stable per-repo key, the
 * repository's path today). The app points it at the per-repo settings (`RepoSettings.columns`,
 * app/columnsPersistence.ts; spec §8.4, "Widths are saved per repo"); until then it's
 * session-only. `save` is called once per gesture that changed something (pointer up, key
 * press), never per pointer move.
 */
export interface ColumnPrefsPersistence { load(repoId: string): ColumnPrefs | null; save(repoId: string, prefs: ColumnPrefs): void }
export const columnPrefsPersistence: ColumnPrefsPersistence = { load: () => null, save: () => {} };

/**
 * THE persistence seam for the hidden columns (spec §8.4, "all except Graph and Message can be
 * hidden"), keyed by repo like the widths. The app points it at the per-repo settings
 * (`RepoSettings.hiddenColumns`, app/columnsPersistence.ts); until then it's session-only. `save`
 * is called once per toggle. Unknown
 * names from storage are dropped on load.
 */
export interface HiddenColumnsPersistence { load(repoId: string): readonly string[] | null; save(repoId: string, hidden: readonly HideableColumn[]): void }
export const hiddenColumnsPersistence: HiddenColumnsPersistence = { load: () => null, save: () => {} };

const loadHidden = (repoId: string): ReadonlySet<HideableColumn> =>
  new Set((hiddenColumnsPersistence.load(repoId) ?? []).filter((c): c is HideableColumn => (HIDEABLE_COLUMNS as readonly string[]).includes(c)));

interface Gesture { col: ResizableColumn; start: ColumnWidths; available: number; graphMax: number; changed: boolean }

interface ColumnPrefsState {
  repoId: string | null;
  prefs: ColumnPrefs;
  /** The repo's hidden columns (spec §8.4). */
  hidden: ReadonlySet<HideableColumn>;
  /** Switches to `repoId`'s saved widths and hidden columns (or the defaults). */
  loadFor(repoId: string): void;
  /** Starts a resize gesture on `col` from the widths currently rendered in an `available`-px
   * table. `graphMax`: the widest the Graph column may get (every lane plus padding, F2). */
  beginResize(col: ResizableColumn, start: ColumnWidths, available: number, graphMax?: number): void;
  /**
   * Moves the gesture's handle `dx` px from its start (resizeColumn). Nothing is written until
   * the first step that actually changes a width, so a stray click, or a key press against a
   * wall, never makes squeezed Author/Date widths permanent.
   */
  resizeBy(dx: number): void;
  /** Ends the gesture: hands the prefs to the persistence seam if the gesture changed them. */
  endResize(): void;
  /** Sets a column's preferred width, clamped to its minimum and rounded to a whole pixel. */
  /** Double-click on a handle (K73): that column back to its default (Graph: auto), persisted. */
  resetWidth(col: ResizableColumn): void;
  setWidth(col: PrefColumn, width: number): void;
  /** Hides a shown column or shows a hidden one, and hands the new set to its seam. */
  toggleHidden(col: HideableColumn): void;
  reset(): void;
}

// The gesture in progress. Not React state: nothing renders from it.
let gesture: Gesture | null = null;

export const useColumnPrefs = create<ColumnPrefsState>((set, get) => ({
  repoId: null,
  prefs: DEFAULT_COLUMN_PREFS,
  hidden: NONE_HIDDEN,
  loadFor: (repoId) => {
    // Re-mounting the same repo's view keeps the session's widths (the seam loads nothing yet).
    if (get().repoId === repoId) return;
    // Merged over the defaults: a stored set from before a column became resizable (SHA) still loads.
    set({ repoId, prefs: { ...DEFAULT_COLUMN_PREFS, ...columnPrefsPersistence.load(repoId) }, hidden: loadHidden(repoId) });
  },
  beginResize: (col, start, available, graphMax = Infinity) => {
    gesture = { col, start, available, graphMax, changed: false };
  },
  resizeBy: (dx) => {
    const g = gesture;
    if (!g) return;
    const patch = resizeColumn(g.col, g.start, dx, g.available, g.graphMax);
    const moved = (Object.keys(patch) as PrefColumn[]).some((k) => patch[k] !== g.start[k]);
    if (!moved && !g.changed) return;
    g.changed = true;
    set((s) => ({ prefs: { ...s.prefs, ...patch } }));
  },
  endResize: () => {
    const g = gesture;
    gesture = null;
    // A Graph gesture ending at its lanes' width stores "auto", so more lanes auto-fit again (F2).
    if (g?.changed && g.col === 'graph') {
      const w = get().prefs.graph;
      if (w !== null && w >= g.graphMax) set((s) => ({ prefs: { ...s.prefs, graph: null } }));
    }
    const { repoId, prefs } = get();
    if (g?.changed && repoId !== null) columnPrefsPersistence.save(repoId, prefs);
  },
  resetWidth: (col) => {
    // Message is the flexing column: its handle trades with Author, so its default is Author's.
    const patch: Partial<ColumnPrefs> = col === 'message' ? { author: DEFAULT_COLUMN_PREFS.author } : { [col]: DEFAULT_COLUMN_PREFS[col] };
    set((s) => ({ prefs: { ...s.prefs, ...patch } }));
    const { repoId, prefs } = get();
    if (repoId !== null) columnPrefsPersistence.save(repoId, prefs);
  },
  setWidth: (col, width) => set((s) => ({ prefs: { ...s.prefs, [col]: Math.min(col === 'sha' ? SHA_MAX : Infinity, Math.max(COLUMN_MIN[col], Math.round(width))) } })),
  toggleHidden: (col) => {
    const next = new Set(get().hidden);
    if (!next.delete(col)) next.add(col);
    set({ hidden: next });
    const { repoId } = get();
    // In the canonical column order, whatever order they were toggled in.
    if (repoId !== null) hiddenColumnsPersistence.save(repoId, HIDEABLE_COLUMNS.filter((c) => next.has(c)));
  },
  reset: () => {
    gesture = null;
    set({ repoId: null, prefs: DEFAULT_COLUMN_PREFS, hidden: NONE_HIDDEN });
  },
}));
