import { DEFAULT_DENSITY, DENSITIES, DENSITY_METRICS, useDensity, type Density } from '../theme/density';
import type { Metrics } from './geometry';

/**
 * The graph's single source of row geometry, in CSS px at 100%, per display density (H1,
 * theme/density.ts): the DOM rows (GraphView), the virtualizer and the canvas (GraphCanvas /
 * draw.ts) all read the same object, so they can't drift apart. Row height, lane width and band
 * inset are the density's; the node padding is half a lane, and draw.ts sizes nodes relative to
 * `rowH`, so the whole graph scales together. One frozen object per density: stable identity,
 * for memoized rows and effects.
 */
export const GRAPH_METRICS: Readonly<Record<Density, Metrics>> = Object.fromEntries(
  DENSITIES.map((d) => {
    const { rowH, laneW, bandInset } = DENSITY_METRICS[d];
    return [d, Object.freeze({ rowH, laneW, padX: laneW / 2, bandInset })];
  }),
) as Record<Density, Metrics>;

/** The default density's metrics (what a fresh profile renders; tests and e2e use it). */
export const METRICS: Metrics = GRAPH_METRICS[DEFAULT_DENSITY];

/** The current density's metrics. */
export const useGraphMetrics = (): Metrics => GRAPH_METRICS[useDensity((s) => s.density)];
