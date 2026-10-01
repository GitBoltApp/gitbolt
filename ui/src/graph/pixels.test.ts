import { describe, expect, it } from 'vitest';
import { connectorLine, dashLength, dashOffset, ringDash, snapScroll } from './pixels';
import { DENSITY_METRICS, DENSITIES } from '../theme/density';

const DPRS = [1, 1.1, 1.2, 1.25, 1.5, 2, 2.4];
const whole = (x: number) => Math.abs(x - Math.round(x)) < 1e-6;

describe('dashLength (K50)', () => {
  it('is a whole number of device px, at least one, at every dpr', () => {
    for (const dpr of DPRS) {
      const d = dashLength(3, dpr);
      expect(whole(d * dpr), `dpr ${dpr}`).toBe(true);
      expect(d * dpr).toBeGreaterThanOrEqual(1);
      expect(Math.abs(d - 3)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
    }
    expect(dashLength(0.1, 1)).toBe(1);
  });
});

describe('dashOffset (K50)', () => {
  /** Where along the absolute content y a path starting at `y0` with `dashOffset(y0)` is in its
   * pattern at `y`: the canvas's phase is the offset plus the distance travelled. */
  const phaseAt = (y0: number, y: number, dash: number) => (dashOffset(y0, dash) + (y - y0)) % (2 * dash);
  /** Two phases are the same point of the pattern (modulo its period, float noise aside). */
  const samePhase = (a: number, b: number, dash: number) => {
    const p = 2 * dash, d = (((a - b) % p) + p) % p;
    return Math.min(d, p - d) < 1e-6;
  };

  it('phases every piece of a lane by its absolute y, so consecutive rows continue the same dashes', () => {
    for (const dpr of DPRS) {
      for (const d of DENSITIES) {
        const { rowH } = DENSITY_METRICS[d];
        const dash = dashLength(3, dpr);
        // Row 7's piece and row 8's piece: at row 8's top, the same phase from either.
        const top8 = 8 * rowH;
        expect(samePhase(phaseAt(7 * rowH, top8, dash), phaseAt(top8, top8, dash), dash)).toBe(true);
        // And a piece starting mid-row (a WIP node's bottom half) agrees with a run from above.
        const mid = 3 * rowH + rowH / 2;
        expect(samePhase(phaseAt(mid, top8, dash), phaseAt(0, top8, dash), dash)).toBe(true);
      }
    }
  });

  it('puts every dash boundary on a whole device px, at any scroll', () => {
    for (const dpr of DPRS) {
      const dash = dashLength(3, dpr);
      for (const scrollDev of [0, 1, 7, 33, 1001]) {
        const scroll = snapScroll(scrollDev / dpr + 1e-9, dpr);
        // A path at local y (canvas px) has content y local + scroll; its dash boundaries are
        // where the phase is a multiple of the dash: local device y = k * dashDev - scrollDev.
        const y0 = 5 * 28 - scroll + 0.37;
        const off = dashOffset(y0 + scroll, dash);
        const firstBoundary = y0 + (dash - (off % dash));
        expect(whole(firstBoundary * dpr), `dpr ${dpr} scroll ${scrollDev}`).toBe(true);
      }
    }
  });

  it('is in [0, period), negative y included', () => {
    expect(dashOffset(-1, 3)).toBe(5);
    expect(dashOffset(6, 3)).toBe(0);
    expect(dashOffset(7.5, 3)).toBe(1.5);
  });
});

describe('connectorLine (K57)', () => {
  it('covers whole device px rows, as many as its width asks, centred on the row to within half a device px', () => {
    for (const dpr of DPRS) {
      for (const d of DENSITIES) {
        const { rowH } = DENSITY_METRICS[d];
        for (const w of [1, 2]) {
          for (let i = 0; i < 40; i++) {
            const l = connectorLine(i * rowH, rowH, w, dpr);
            expect(whole(l.top * dpr), `top dpr ${dpr} ${d} row ${i}`).toBe(true);
            expect(l.height * dpr).toBe(Math.max(1, Math.round(w * dpr)));
            expect(l.centre).toBeCloseTo(l.top + l.height / 2, 9);
            expect(Math.abs(l.centre - (i * rowH + rowH / 2)) * dpr).toBeLessThanOrEqual(0.5 + 1e-9);
          }
        }
      }
    }
  });

  it('a canvas stroke at centre less the snapped scroll covers exactly the DOM half\'s rows', () => {
    // An odd device width is centred on a half device px, an even one on a whole one.
    expect(connectorLine(0, 28, 1, 1).centre).toBe(14.5);
    expect(connectorLine(0, 28, 2, 1).centre).toBe(14);
    const l = connectorLine(28, 28, 1, 1.2);
    // (28 + 14) * 1.2 = 50.4, less half a device px: 49.9, rounds to 50.
    expect(l.top * 1.2).toBeCloseTo(50, 9);
    expect(l.centre * 1.2).toBeCloseTo(50.5, 9);
  });
});

describe('ringDash (K50)', () => {
  it('divides the circumference into a whole number of dash+gap pairs near the target', () => {
    for (const r of [9, 10.08, 11.52, 7.3]) {
      const d = ringDash(r, 2);
      const pairs = (2 * Math.PI * r) / (2 * d);
      expect(whole(pairs)).toBe(true);
      expect(Math.abs(d - 2)).toBeLessThan(0.5);
    }
  });
});
