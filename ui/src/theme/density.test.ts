import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DENSITY, DENSITIES, DENSITY_METRICS, DENSITY_STORAGE_KEY, densityCssVars, densityPersistence, parseDensity, useDensity } from './density';

describe('density presets (feedback H1)', () => {
  it('three presets, standard the default', () => {
    expect(DENSITIES).toEqual(['compact', 'standard', 'comfortable']);
    expect(DEFAULT_DENSITY).toBe('standard');
  });

  it('compact keeps the 1A/1B metrics; standard is the measured target at the same zoom', () => {
    expect(DENSITY_METRICS.compact).toMatchObject({ rowH: 25, laneW: 16, chipH: 17, cellPadX: 6, fileRowH: 24 });
    // The target at 120%: 33.5 px row pitch, 26.5 px chips and bands, 26.7 px lane pitch -> / 1.2.
    expect(DENSITY_METRICS.standard).toMatchObject({ rowH: 28, laneW: 22, chipH: 22 });
  });

  it('each step is roomier than the one before it, in every metric', () => {
    for (const k of ['rowH', 'laneW', 'chipH', 'cellPadX', 'fileRowH', 'bandInset', 'panelBarH'] as const) {
      expect(DENSITY_METRICS.compact[k], k).toBeLessThanOrEqual(DENSITY_METRICS.standard[k]);
      expect(DENSITY_METRICS.standard[k], k).toBeLessThanOrEqual(DENSITY_METRICS.comfortable[k]);
    }
    expect(DENSITY_METRICS.comfortable.rowH).toBeGreaterThan(DENSITY_METRICS.standard.rowH);
  });

  it('chips and the canvas band fit their row: the band is the row less its inset top and bottom, never shorter than a chip', () => {
    for (const d of DENSITIES) {
      const m = DENSITY_METRICS[d];
      expect(m.chipH, d).toBeLessThanOrEqual(m.rowH - 2 * m.bandInset);
      expect(m.bandInset, d).toBeGreaterThan(0);
    }
  });

  it('exposes the table\'s CSS variables, the file-list row height included', () => {
    expect(densityCssVars('standard')).toEqual({
      '--graph-row-h': '28px',
      '--graph-chip-h': '22px',
      '--graph-cell-pad-x': `${DENSITY_METRICS.standard.cellPadX}px`,
      '--file-row-h': `${DENSITY_METRICS.standard.fileRowH}px`,
      '--panel-bar-h': '37px',
    });
  });

  it('K6: the panels\' top bar (the open file\'s path/encoding/×, the details header\'s hashes) is 20% taller than 1B\'s 30 px at standard; compact keeps 1B\'s', () => {
    // Outer heights, 1 px bottom border included: 1B's bar was 30 px plus its border.
    expect(DENSITY_METRICS.compact.panelBarH).toBe(31);
    expect(DENSITY_METRICS.standard.panelBarH).toBe(30 * 1.2 + 1);
    expect(DENSITY_METRICS.comfortable.panelBarH).toBeGreaterThan(DENSITY_METRICS.standard.panelBarH);
  });

  it('keeps the variables on :root, in step with the store (the graph and the details panel are siblings)', () => {
    for (const d of DENSITIES) {
      useDensity.setState({ density: d });
      for (const [k, v] of Object.entries(densityCssVars(d))) expect(document.documentElement.style.getPropertyValue(k), `${d} ${k}`).toBe(v);
    }
    useDensity.setState({ density: DEFAULT_DENSITY });
  });

  it('parses only the three names', () => {
    expect(parseDensity('comfortable')).toBe('comfortable');
    expect(parseDensity('huge')).toBeNull();
    expect(parseDensity(null)).toBeNull();
  });
});

describe('density persistence seam (gitbolt.density.v1)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('saves under gitbolt.density.v1 and loads it back', () => {
    densityPersistence.save('compact');
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact');
    expect(densityPersistence.load()).toBe('compact');
  });

  it('an unknown stored value, or storage that throws, loads nothing (and saving never throws)', () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, 'dense');
    expect(densityPersistence.load()).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(densityPersistence.load()).toBeNull();
    expect(() => densityPersistence.save('compact')).not.toThrow();
  });

  it('the store starts from the saved density (else the default), and setDensity saves it', () => {
    useDensity.getState().reload();
    expect(useDensity.getState().density).toBe('standard');
    localStorage.setItem(DENSITY_STORAGE_KEY, 'comfortable');
    useDensity.getState().reload();
    expect(useDensity.getState().density).toBe('comfortable');
    useDensity.getState().setDensity('compact');
    expect(useDensity.getState().density).toBe('compact');
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact');
  });
});
