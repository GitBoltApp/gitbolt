import { describe, expect, it } from 'vitest';
import { DEFAULT_DENSITY, DENSITIES, DENSITY_METRICS } from '../theme/density';
import { laneX, segmentPath } from './geometry';
import { GRAPH_METRICS, METRICS } from './metrics';
import { decodeSegment, HALF_BOTTOM, HALF_FULL, HALF_TOP } from './segments';

const pack = (from: number, to: number, half: number) => from | (to << 10) | (half << 20);

describe('graph metrics derive from the density (feedback H1)', () => {
  it('row height, lane width and band inset are the density\'s; METRICS is the default density\'s', () => {
    for (const d of DENSITIES) {
      const { rowH, laneW, bandInset } = DENSITY_METRICS[d];
      expect(GRAPH_METRICS[d]).toMatchObject({ rowH, laneW, bandInset });
    }
    expect(METRICS).toBe(GRAPH_METRICS[DEFAULT_DENSITY]);
  });

  it('the node padding scales with the lane width', () => {
    expect(GRAPH_METRICS.compact.padX).toBe(8);
    for (const d of DENSITIES) expect(GRAPH_METRICS[d].padX, d).toBe(GRAPH_METRICS[d].laneW / 2);
  });

  // Continuity: a line leaving a row's bottom edge enters the next row's top edge at the same
  // x, and a node's curves meet the node's centre, whatever the density.
  for (const d of DENSITIES) {
    it(`${d}: every segment shape is continuous across row boundaries and meets the node centre`, () => {
      const m = GRAPH_METRICS[d];
      const top = 3 * m.rowH;
      const shapes = [[1, 1, HALF_FULL], [0, 0, HALF_TOP], [0, 0, HALF_BOTTOM], [2, 0, HALF_TOP], [0, 2, HALF_BOTTOM], [1, 0, HALF_TOP], [0, 1, HALF_BOTTOM]] as const;
      for (const [from, to, half] of shapes) {
        const p = segmentPath(decodeSegment(pack(from, to, half)), top, m);
        const first = p[0], last = p[p.length - 1];
        const label = `${d} ${from}->${to} half ${half}`;
        if (half === HALF_BOTTOM) {
          // Leaves the node at `from`'s centre, exits the row's bottom at `to`'s lane.
          expect([first.x, first.y], label).toEqual([laneX(from, m), top + m.rowH / 2]);
          expect([last.x, last.y], label).toEqual([laneX(to, m), top + m.rowH]);
        } else if (half === HALF_TOP) {
          // Enters at the row's top on `from`'s lane, reaches the node at `to`'s centre.
          expect([first.x, first.y], label).toEqual([laneX(from, m), top]);
          expect([last.x, last.y], label).toEqual([laneX(to, m), top + m.rowH / 2]);
        } else {
          expect([first.x, first.y, last.x, last.y], label).toEqual([laneX(from, m), top, laneX(to, m), top + m.rowH]);
        }
      }
    });
  }
});
