import type { Metrics } from './geometry';

/**
 * The graph's single source of row geometry, in CSS px at 100%: the DOM rows (GraphView), the
 * virtualizer and the canvas (GraphCanvas / draw.ts) all read this one object, so they can't
 * drift apart. draw.ts sizes nodes relative to `rowH`.
 */
export const METRICS: Metrics = { rowH: 25, laneW: 16, padX: 8 };
