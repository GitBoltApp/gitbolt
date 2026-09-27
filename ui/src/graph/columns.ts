import { create } from 'zustand';
import type { Metrics } from './geometry';

/** The graph table's columns, left to right: Branch/Tag · Graph · Message · Author · Date · SHA. */
export type ResizableColumn = 'labels' | 'graph' | 'author' | 'date';

/** Minimum widths, CSS px (Task 15). Message's minimum is where the smart fit starts squeezing
 * Author and Date; SHA is fixed. */
export const COLUMN_MIN = { labels: 80, graph: 48, author: 60, date: 90, message: 160 } as const;
export const SHA_W = 72;

/** The user's preferred widths. `graph: null` means "fit the lanes" (autoGraphWidth). */
export interface ColumnPrefs { labels: number; graph: number | null; author: number; date: number }
export const DEFAULT_COLUMN_PREFS: ColumnPrefs = { labels: 200, graph: null, author: 160, date: 170 };

export interface ColumnWidths { labels: number; graph: number; message: number; author: number; date: number; sha: number; total: number }

/**
 * The graph column's width before the user resizes it: every lane plus padding, at least
 * 64 px. Deliberately uncapped, so no lane (and no commit on it) is ever clipped at the default
 * width; a table wider than the window scrolls horizontally. Narrowing the column by hand can
 * still clip lanes: the §8.3 collapse zone that handles that is plan 1C (a known 1A limitation).
 */
export const autoGraphWidth = (maxLanes: number, m: Pick<Metrics, 'laneW' | 'padX'>) =>
  Math.max(64, maxLanes * m.laneW + 2 * m.padX);

const MIN_TOTAL = COLUMN_MIN.labels + COLUMN_MIN.graph + COLUMN_MIN.message + COLUMN_MIN.author + COLUMN_MIN.date + SHA_W;

/** The widest a resizable column can be dragged in an `available`-px table: whatever is left
 * once every other column is at its minimum (never below the column's own minimum). */
export const columnMax = (col: ResizableColumn, available: number) =>
  Math.max(COLUMN_MIN[col], available - (MIN_TOTAL - COLUMN_MIN[col]));

/**
 * Smart fit (spec §8.4): turns preferred widths into the widths actually rendered for a table
 * `available` px wide. Pure, whole pixels in and out.
 * 1. Branch/Tag, Graph and SHA always get their width (clamped to their minimums).
 * 2. Message takes whatever is left over, as long as that's at least its minimum; so widening
 *    the window only ever grows Message, and narrowing shrinks it first.
 * 3. Once Message is at its minimum, Author and Date shrink toward their minimums, each in
 *    proportion to its room above its minimum (so both reach their minimums together).
 * 4. Below the sum of the minimums, `total` exceeds `available` and the table scrolls.
 */
export function allocateColumns(prefs: { labels: number; graph: number; author: number; date: number }, available: number): ColumnWidths {
  const labels = Math.max(COLUMN_MIN.labels, prefs.labels);
  const graph = Math.max(COLUMN_MIN.graph, prefs.graph);
  let author = Math.max(COLUMN_MIN.author, prefs.author);
  let date = Math.max(COLUMN_MIN.date, prefs.date);
  const leftover = available - (labels + graph + author + date + SHA_W);
  if (leftover >= COLUMN_MIN.message) {
    return { labels, graph, message: leftover, author, date, sha: SHA_W, total: available };
  }
  const deficit = COLUMN_MIN.message - leftover;
  const roomA = author - COLUMN_MIN.author;
  const roomD = date - COLUMN_MIN.date;
  if (deficit >= roomA + roomD) {
    author = COLUMN_MIN.author;
    date = COLUMN_MIN.date;
  } else {
    const fromA = Math.round((deficit * roomA) / (roomA + roomD));
    author -= fromA;
    date -= deficit - fromA;
  }
  const message = COLUMN_MIN.message;
  return { labels, graph, message, author, date, sha: SHA_W, total: labels + graph + message + author + date + SHA_W };
}

type PrefsPatch = Partial<Record<ResizableColumn, number>>;

/**
 * One resize gesture step (pure): the preference patch that moves `col`'s handle `dx` px from
 * where it was at gesture start (`start`, the rendered widths then). Positive `dx` is rightward.
 * The rule is that the boundary under the pointer is the one that moves, 1:1, until it hits a wall:
 * - Branch/Tag and Graph (handle on their right edge) widen by `dx`, between their minimum and
 *   `max(columnMax, start width)`. A column already wider than columnMax (the window narrowed
 *   after it was widened) is never pulled back by a widening gesture.
 * - Author (handle on its left edge) widens out of Message only; Message at its minimum is a wall.
 * - Date (handle on its left edge) widens out of Message first, then 1:1 out of Author (Author's
 *   preference drops by the same amount) until Author is at its minimum.
 * - Narrowing Author or Date hands the space to Message.
 * Author/Date patches set both of them to what will be rendered, so no preference is left above
 * its rendered width (nothing jumps when the window widens again).
 */
export function resizeColumn(col: ResizableColumn, start: ColumnWidths, dx: number, available: number): PrefsPatch {
  dx = Math.round(dx);
  if (col === 'labels' || col === 'graph') {
    const max = Math.max(columnMax(col, available), start[col]);
    return { [col]: Math.min(max, Math.max(COLUMN_MIN[col], start[col] + dx)) };
  }
  const grow = -dx; // the handle is the column's left edge: moving it left widens the column
  const fromMessage = Math.max(0, start.message - COLUMN_MIN.message);
  if (col === 'author') {
    const author = grow >= 0 ? start.author + Math.min(grow, fromMessage) : Math.max(COLUMN_MIN.author, start.author + grow);
    return { author, date: start.date };
  }
  if (grow < 0) return { author: start.author, date: Math.max(COLUMN_MIN.date, start.date + grow) };
  const takeMessage = Math.min(grow, fromMessage);
  const takeAuthor = Math.min(grow - takeMessage, start.author - COLUMN_MIN.author);
  return { author: start.author - takeAuthor, date: start.date + takeMessage + takeAuthor };
}

/**
 * THE persistence seam for column widths, keyed by repo (`repoId`: a stable per-repo key, the
 * repository's path today). Session-only for now: nothing is loaded and saves go nowhere, so
 * widths last as long as the window. Plan 1C replaces this one object with the per-repo settings
 * store (spec §8.4, "Widths are saved per repo"); nothing else changes. `save` is called once
 * per gesture that changed something (pointer up, key press), never per pointer move.
 */
export interface ColumnPrefsPersistence { load(repoId: string): ColumnPrefs | null; save(repoId: string, prefs: ColumnPrefs): void }
export const columnPrefsPersistence: ColumnPrefsPersistence = { load: () => null, save: () => {} };

interface Gesture { col: ResizableColumn; start: ColumnWidths; available: number; changed: boolean }

interface ColumnPrefsState {
  repoId: string | null;
  prefs: ColumnPrefs;
  /** Switches to `repoId`'s saved widths (or the defaults). */
  loadFor(repoId: string): void;
  /** Starts a resize gesture on `col` from the widths currently rendered in an `available`-px table. */
  beginResize(col: ResizableColumn, start: ColumnWidths, available: number): void;
  /**
   * Moves the gesture's handle `dx` px from its start (resizeColumn). Nothing is written until
   * the first step that actually changes a width, so a stray click, or a key press against a
   * wall, never makes squeezed Author/Date widths permanent.
   */
  resizeBy(dx: number): void;
  /** Ends the gesture: hands the prefs to the persistence seam if the gesture changed them. */
  endResize(): void;
  /** Sets a column's preferred width, clamped to its minimum and rounded to a whole pixel. */
  setWidth(col: ResizableColumn, width: number): void;
  reset(): void;
}

// The gesture in progress. Not React state: nothing renders from it.
let gesture: Gesture | null = null;

export const useColumnPrefs = create<ColumnPrefsState>((set, get) => ({
  repoId: null,
  prefs: DEFAULT_COLUMN_PREFS,
  loadFor: (repoId) => {
    // Re-mounting the same repo's view keeps the session's widths (the seam loads nothing yet).
    if (get().repoId === repoId) return;
    set({ repoId, prefs: columnPrefsPersistence.load(repoId) ?? DEFAULT_COLUMN_PREFS });
  },
  beginResize: (col, start, available) => {
    gesture = { col, start, available, changed: false };
  },
  resizeBy: (dx) => {
    const g = gesture;
    if (!g) return;
    const patch = resizeColumn(g.col, g.start, dx, g.available);
    const moved = (Object.keys(patch) as ResizableColumn[]).some((k) => patch[k] !== g.start[k]);
    if (!moved && !g.changed) return;
    g.changed = true;
    set((s) => ({ prefs: { ...s.prefs, ...patch } }));
  },
  endResize: () => {
    const g = gesture;
    gesture = null;
    const { repoId, prefs } = get();
    if (g?.changed && repoId !== null) columnPrefsPersistence.save(repoId, prefs);
  },
  setWidth: (col, width) => set((s) => ({ prefs: { ...s.prefs, [col]: Math.max(COLUMN_MIN[col], Math.round(width)) } })),
  reset: () => {
    gesture = null;
    set({ repoId: null, prefs: DEFAULT_COLUMN_PREFS });
  },
}));
