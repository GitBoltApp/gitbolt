import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowPayload } from '../api/gen/RowPayload';
import { bandOverscan } from './band';
import { SELECTED_BAND_ALPHA } from './draw';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas';
import { METRICS } from './metrics';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

const metrics = METRICS;
const rows: RowPayload[] = [
  { id: 'a'.repeat(40), kind: 'commit', lane: 0, color: 0, segments: [], summary: '', bodyFirstLine: '', authorName: 'Ada Lovelace', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null },
];

/** A minimal `matchMedia` mock: tracks listeners per query and lets a test fire 'change'. */
function mockMatchMedia() {
  const listeners = new Map<string, Set<() => void>>();
  const queries: string[] = [];
  const matchMedia = vi.fn((query: string) => {
    queries.push(query);
    listeners.set(query, new Set());
    return {
      media: query,
      matches: true,
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'change') listeners.get(query)!.add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        if (type === 'change') listeners.get(query)?.delete(cb);
      },
    } as unknown as MediaQueryList;
  });
  return {
    matchMedia,
    queries,
    fireChange(query: string) {
      for (const cb of listeners.get(query) ?? []) cb();
    },
  };
}

function setDevicePixelRatio(value: number) {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
}

describe('GraphCanvas', () => {
  let originalDpr: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  });

  afterEach(() => {
    if (originalDpr) Object.defineProperty(window, 'devicePixelRatio', originalDpr);
    vi.unstubAllGlobals();
  });

  it('installs a resolution change listener and redraws at the new backing size when it fires', () => {
    setDevicePixelRatio(1);
    const { matchMedia, queries, fireChange } = mockMatchMedia();
    vi.stubGlobal('matchMedia', matchMedia);

    const { getByTestId } = render(
      <GraphCanvas rows={rows} width={100} height={44} left={200} metrics={metrics} labeledRows={new Set()} />,
    );
    const canvas = getByTestId('graph-canvas') as HTMLCanvasElement;
    expect(matchMedia).toHaveBeenCalledWith('(resolution: 1dppx)');
    expect(canvas.width).toBe(100);
    // The band: the 44 px viewport and its overscan above and below (band.ts).
    const bandH = 44 + 2 * bandOverscan(44, metrics.rowH, 1);
    expect(canvas.height).toBe(bandH);

    // A monitor move or OS zoom change with no resize: dpr changes, nothing else fires.
    setDevicePixelRatio(2);
    act(() => fireChange('(resolution: 1dppx)'));

    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(Math.round((44 + 2 * bandOverscan(44, metrics.rowH, 2)) * 2));
    // The listener re-arms itself at the new ratio rather than staying subscribed at the old one.
    expect(queries).toContain('(resolution: 2dppx)');
  });

  it('redraws with the selected row\'s brighter band when the selection moves (H14)', () => {
    const alphas: unknown[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : () => {}),
      set: (t, k: string, v) => { t[k] = v; if (k === 'globalAlpha') alphas.push(v); return true; },
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
    const two = [rows[0], { ...rows[0], id: 'b'.repeat(40) }];
    const { rerender } = render(<GraphCanvas rows={two} width={100} height={60} left={0} metrics={metrics} labeledRows={new Set()} />);
    expect(alphas).not.toContain(SELECTED_BAND_ALPHA);
    alphas.length = 0;
    rerender(<GraphCanvas rows={two} width={100} height={60} left={0} metrics={metrics} labeledRows={new Set()} selected={1} />);
    expect(alphas.filter((a) => a === SELECTED_BAND_ALPHA)).toHaveLength(1);
    getContext.mockRestore();
  });

  it('does not throw when matchMedia is unavailable (older WebViews, jsdom)', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(() => render(
      <GraphCanvas rows={rows} width={100} height={44} left={200} metrics={metrics} labeledRows={new Set()} />,
    )).not.toThrow();
  });
  describe('in the scrolled content (band.ts)', () => {
    // 1000 rows of 28 px under a 560 px viewport: a 10-row overscan, redrawn 5 rows from an edge.
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...rows[0], id: String(i).padStart(40, '0') }));
    const setup = () => {
      setDevicePixelRatio(1);
      const clears: unknown[] = [];
      const ctx = new Proxy({} as Record<string, unknown>, {
        get: (t, k: string) => (k in t ? t[k] : k === 'clearRect' ? () => clears.push(k) : () => {}),
        set: (t, k: string, v) => { t[k] = v; return true; },
      });
      const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
      const scroller = document.createElement('div');
      document.body.append(scroller);
      const handle = createRef<GraphCanvasHandle>();
      const view = render(<GraphCanvas ref={handle} scroller={{ current: scroller }} rows={many} width={100} height={560} left={0} metrics={{ ...metrics, rowH: 28 }} labeledRows={new Set()} />);
      const canvas = view.getByTestId('graph-canvas') as HTMLCanvasElement;
      const scrollTo = (y: number) => { scroller.scrollTop = y; handle.current!.sync(); };
      return { clears, canvas, scroller, scrollTo, handle, done: () => { getContext.mockRestore(); scroller.remove(); } };
    };

    it('is drawn once for the band; scrolling within it redraws nothing (the compositor moves it)', () => {
      const { clears, canvas, scrollTo, done } = setup();
      expect(clears).toHaveLength(1);
      expect(canvas.style.top).toBe('0px');
      expect(canvas.height).toBe(560 + 2 * 280);
      for (const y of [13, 101, 277.5, 419]) scrollTo(y);
      expect(clears).toHaveLength(1);
      done();
    });

    it('redraws, re-centred on whole rows, once the viewport nears the band\'s edge', () => {
      const { clears, canvas, scrollTo, done } = setup();
      scrollTo(900); // past 0..1120 less the 140 px slack
      expect(clears).toHaveLength(2);
      // Row 32 (896..924) less the 10-row overscan.
      expect(canvas.style.top).toBe(`${32 * 28 - 280}px`);
      scrollTo(1000);
      expect(clears).toHaveLength(2);
      scrollTo(10_000);
      expect(clears).toHaveLength(3);
      expect(canvas.style.top).toBe(`${Math.floor(10_000 / 28) * 28 - 280}px`);
      done();
    });

    it('follows a scroll set from outside at once through its handle', () => {
      const { clears, canvas, scroller, handle, done } = setup();
      scroller.scrollTop = 5600;
      act(() => handle.current!.sync());
      expect(clears).toHaveLength(2);
      expect(canvas.style.top).toBe(`${5600 - 280}px`);
      done();
    });
  });
});
