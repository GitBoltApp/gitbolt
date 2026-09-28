import { create } from 'zustand';

/**
 * Display density (feedback H1): three presets for the row height and cell paddings of the
 * graph table, and the file list's row height (which the details panel adopts). The graph
 * canvas's metrics derive from these too (graph/metrics.ts), so node size, lane width and row
 * height scale together.
 *
 * - `compact`: the 1A/1B metrics.
 * - `standard` (the default): measured at 120% zoom (feedback H1): rows 33.5 px apart, chips
 *   and row bands 26.5 px tall and lanes 26.7 px apart, i.e. 28, 22 and 22 CSS px.
 * - `comfortable`: more padding than standard.
 *
 * No UI picks it yet: the app has no menu, and plan 1C's settings screen adds the setting. It's
 * persisted under DENSITY_STORAGE_KEY, through `densityPersistence` below.
 */
export type Density = 'compact' | 'standard' | 'comfortable';
export const DENSITIES: readonly Density[] = ['compact', 'standard', 'comfortable'];
export const DEFAULT_DENSITY: Density = 'standard';
export const DENSITY_STORAGE_KEY = 'gitbolt.density.v1';

export interface DensityMetrics {
  /** Graph table row height, CSS px: the DOM rows, the virtualizer and the canvas. */
  rowH: number;
  /** Graph lane width (canvas). */
  laneW: number;
  /** Vertical inset of the canvas's row band and rail, top and bottom. */
  bandInset: number;
  /** A ref chip's height. */
  chipH: number;
  /** Horizontal padding of the graph table's header and row cells. SHA keeps its fixed 6 px,
   * which its width limits assume (graph/columns.ts). */
  cellPadX: number;
  /** The details panel's file-list row height. */
  fileRowH: number;
}

export const DENSITY_METRICS: Readonly<Record<Density, DensityMetrics>> = {
  compact: { rowH: 25, laneW: 16, bandInset: 2, chipH: 17, cellPadX: 6, fileRowH: 24 },
  standard: { rowH: 28, laneW: 22, bandInset: 3, chipH: 22, cellPadX: 8, fileRowH: 26 },
  comfortable: { rowH: 32, laneW: 24, bandInset: 4, chipH: 24, cellPadX: 10, fileRowH: 30 },
};

/** The CSS custom properties a density sets (kept on :root, below): graph.css reads the
 * `--graph-*` ones; `--file-row-h` is there for the file list. */
export function densityCssVars(d: Density): Record<string, string> {
  const m = DENSITY_METRICS[d];
  return {
    '--graph-row-h': `${m.rowH}px`,
    '--graph-chip-h': `${m.chipH}px`,
    '--graph-cell-pad-x': `${m.cellPadX}px`,
    '--file-row-h': `${m.fileRowH}px`,
  };
}

/** A stored value → its density; anything else is `null`. */
export const parseDensity = (raw: string | null): Density | null =>
  (DENSITIES as readonly string[]).includes(raw ?? '') ? (raw as Density) : null;

/**
 * THE persistence seam for the density: localStorage today (every access guarded, since it can
 * throw); plan 1C swaps this one object for its settings store (spec §15). Nothing else changes.
 */
export interface DensityPersistence { load(): Density | null; save(d: Density): void }
export const densityPersistence: DensityPersistence = {
  load: () => {
    try {
      return parseDensity(globalThis.localStorage.getItem(DENSITY_STORAGE_KEY));
    } catch {
      return null;
    }
  },
  save: (d) => {
    try {
      globalThis.localStorage.setItem(DENSITY_STORAGE_KEY, d);
    } catch {
      // Not persisted this session; the density still applies.
    }
  },
};

interface DensityState {
  density: Density;
  /** Sets and saves the density. Plan 1C's settings screen calls this. */
  setDensity(d: Density): void;
  /** Re-reads the saved density (tests; a settings import). */
  reload(): void;
}

export const useDensity = create<DensityState>((set) => ({
  density: densityPersistence.load() ?? DEFAULT_DENSITY,
  setDensity: (density) => {
    densityPersistence.save(density);
    set({ density });
  },
  reload: () => set({ density: densityPersistence.load() ?? DEFAULT_DENSITY }),
}));

/** Puts a density's CSS variables on :root, the one ancestor the graph and the details panel
 * (siblings) share. No-op without a DOM. */
function applyDensityVars(d: Density) {
  const style = globalThis.document?.documentElement?.style;
  if (!style) return;
  for (const [k, v] of Object.entries(densityCssVars(d))) style.setProperty(k, v);
}

// Set once at load and on every change, so the variables are there before the first paint of
// anything that reads them, whichever view mounts first.
applyDensityVars(useDensity.getState().density);
useDensity.subscribe((s, prev) => {
  if (s.density !== prev.density) applyDensityVars(s.density);
});
