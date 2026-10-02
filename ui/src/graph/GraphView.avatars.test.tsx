import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';

const avatar = vi.hoisted(() => vi.fn(async (email: string) => (email === 'ada@example.com' ? { mime: 'image/png', base64: btoa('png') } : null)));
vi.mock('../api/client', () => ({ api: { avatar } }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));
// Counts label-cell renders: a proxy for "did the virtual row re-render".
const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock('./RefLabels', () => ({ RefLabels: () => { renders.n++; return null; } }));

import { DEFAULT_DENSITY, useDensity } from '../theme/density';
import { AVATAR_OVERSCAN, GraphView } from './GraphView';

const calls: string[] = [];
const bitmap = { width: 80, height: 80 } as ImageBitmap;
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => { calls.push(`${k}(${a.map((x) => (x === bitmap ? 'bitmap' : typeof x)).join(',')})`); }),
    set: (t, k: string, v) => { t[k] = v; return true; },
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
});

const row = (i: number, name: string, email: string) => ({ id: String(i).padStart(40, '0'), kind: 'commit' as const, lane: 0, color: 0, segments: [], summary: `c${i}`, bodyFirstLine: '', authorName: name, authorEmail: email, authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graph: GraphPayload = {
  rows: [row(0, 'Ada Lovelace', 'Ada@Example.com'), row(1, 'Grace Hopper', 'grace@example.com'), row(2, 'Ada Lovelace', 'ada@example.com')],
  labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [],
};

describe('GraphView avatars', () => {
  it('asks once per on-screen email and redraws the canvas with the bitmap, without re-rendering rows', async () => {
    render(<GraphView graph={graph} repoId="/repo" />);
    const rowsBefore = renders.n;
    expect(rowsBefore).toBeGreaterThan(0);
    expect(calls.some((c) => c.startsWith('drawImage('))).toBe(false);
    calls.length = 0;
    await act(async () => {});
    await act(async () => {});
    expect(avatar.mock.calls.map((c) => c[0]).sort()).toEqual(['ada@example.com', 'grace@example.com']);
    // Two of the three nodes are Ada's: both drawn from the one cached bitmap.
    expect(calls.filter((c) => c === 'drawImage(bitmap,number,number,number,number)')).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith('fillText('))).toHaveLength(1);
    expect(renders.n).toBe(rowsBefore);
  });
});

describe('GraphView avatars during a fast scroll', () => {
  // The arithmetic below is in compact's 25 px rows.
  beforeAll(() => useDensity.setState({ density: 'compact' }));
  afterAll(() => useDensity.setState({ density: DEFAULT_DENSITY }));
  it('asks only for the visible rows, latest set wins: rows scrolled past before their turn are never fetched', async () => {
    const pending = new Map<string, (v: null) => void>();
    avatar.mockImplementation((email: string) => new Promise((r) => pending.set(email, r)));
    avatar.mockClear();
    const many: GraphPayload = { ...graph, rows: Array.from({ length: 300 }, (_, i) => row(100 + i, `P ${i}`, `p${i}@example.com`)) };
    render(<GraphView graph={many} repoId="/repo" />);
    await act(async () => {});
    const fetched = () => avatar.mock.calls.map((c) => c[0]);
    // 4 at a time; the other rows on screen (plus AVATAR_OVERSCAN) queue. The virtualizer's 20
    // overscan rows aren't asked for at all.
    expect(fetched()).toEqual(['p0@example.com', 'p1@example.com', 'p2@example.com', 'p3@example.com']);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    grid.scrollTop = 200 * 25;
    fireEvent.scroll(grid);
    // Let everything drain.
    for (let round = 0; round < 40 && pending.size > 0; round++) {
      await act(async () => {
        const settle = [...pending.values()];
        pending.clear();
        for (const r of settle) r(null);
      });
    }
    const rowsFetched = fetched().slice(4).map((e) => Number(/p(\d+)@/.exec(e)![1])).sort((x, y) => x - y);
    // Exactly the 24 rows now on screen (600px / 25px) plus AVATAR_OVERSCAN either side: none of
    // the rows scrolled past (4–28), and none of the virtualizer's wider overscan.
    expect(AVATAR_OVERSCAN).toBe(5);
    expect(rowsFetched).toEqual(Array.from({ length: 24 + 2 * AVATAR_OVERSCAN }, (_, i) => 200 - AVATAR_OVERSCAN + i));
  });
});

describe('GraphView avatars with elastic overscroll', () => {
  it('a negative scrollTop (WebKit rubber-banding) asks for the top rows instead of throwing', async () => {
    avatar.mockImplementation(async () => null);
    avatar.mockClear();
    const g: GraphPayload = { ...graph, rows: Array.from({ length: 60 }, (_, i) => row(500 + i, `Q ${i}`, `q${i}@example.com`)) };
    render(<GraphView graph={g} repoId="/repo" />);
    await act(async () => {});
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    Object.defineProperty(grid, 'scrollTop', { configurable: true, value: -40 });
    fireEvent.scroll(grid);
    await act(async () => {});
    await act(async () => {});
    expect(avatar.mock.calls.map((c) => c[0])).toContain('q0@example.com');
  });
});
