import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowPayload } from '../api/gen/RowPayload';
import { GraphCanvas } from './GraphCanvas';
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
      <GraphCanvas rows={rows} scrollTop={0} width={100} height={44} left={200} metrics={metrics} labeledRows={new Set()} />,
    );
    const canvas = getByTestId('graph-canvas') as HTMLCanvasElement;
    expect(matchMedia).toHaveBeenCalledWith('(resolution: 1dppx)');
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(44);

    // A monitor move or OS zoom change with no resize: dpr changes, nothing else fires.
    setDevicePixelRatio(2);
    act(() => fireChange('(resolution: 1dppx)'));

    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(88);
    // The listener re-arms itself at the new ratio rather than staying subscribed at the old one.
    expect(queries).toContain('(resolution: 2dppx)');
  });

  it('does not throw when matchMedia is unavailable (older WebViews, jsdom)', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(() => render(
      <GraphCanvas rows={rows} scrollTop={0} width={100} height={44} left={200} metrics={metrics} labeledRows={new Set()} />,
    )).not.toThrow();
  });
});
