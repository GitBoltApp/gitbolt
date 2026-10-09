import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ mergeBase: vi.fn(), fileList: vi.fn() }));
vi.mock('../../api/client', () => ({ api }));

const { useRangeStats, useRangeStatsRecheck, clearRangeStats } = await import('./rangeStats');
const { useRuntime } = await import('../../app/runtime');

const TIP = 't'.repeat(40);
const BASE = 'b'.repeat(40);

beforeEach(() => {
  clearRangeStats();
  api.mergeBase.mockReset().mockResolvedValue(BASE);
  api.fileList.mockReset().mockResolvedValue({ files: [{}, {}], added: 10, deleted: 3 });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 }, graph: { rows: [], labels: [] } } as never } } as never);
});

describe('useRangeStats', () => {
  it('a view shown again starts with the stats it had, not a loading state, and refreshes them', async () => {
    const first = renderHook(() => useRangeStats('t', TIP, 'refs/remotes/origin/main'));
    expect(first.result.current.status).toBe('loading');
    await act(async () => {});
    expect(first.result.current).toMatchObject({ status: 'ready', stats: { files: 2, added: 10, deleted: 3 } });
    first.unmount();

    api.fileList.mockResolvedValue({ files: [{}, {}, {}], added: 11, deleted: 3 });
    const again = renderHook(() => useRangeStats('t', TIP, 'refs/remotes/origin/main'));
    expect(again.result.current).toMatchObject({ status: 'ready', stats: { files: 2 } });
    await act(async () => {});
    expect(again.result.current).toMatchObject({ status: 'ready', stats: { files: 3, added: 11 } });
  });

  it('a reloaded graph asks again, so a fetch that brings the commits replaces a cached none', async () => {
    api.mergeBase.mockResolvedValue(null);
    const a = renderHook(() => useRangeStats('t', TIP, 'refs/remotes/origin/main'));
    await act(async () => {});
    expect(a.result.current.status).toBe('none');
    a.unmount();
    // Reopened: the cached none shows first, with no loading flash.
    const b = renderHook(() => useRangeStats('t', TIP, 'refs/remotes/origin/main'));
    expect(b.result.current.status).toBe('none');
    api.mergeBase.mockResolvedValue(BASE);
    await act(async () => { useRuntime.setState({ tabs: { t: { repo: { id: 4 }, graph: { rows: [], labels: [{ name: 'origin/f', row: 0 }] } } as never } } as never); });
    expect(b.result.current).toMatchObject({ status: 'ready', stats: { files: 2 } });
  });

  it('recheck asks at once and resolves with the answer', async () => {
    api.mergeBase.mockResolvedValue(null);
    const h = renderHook(() => useRangeStatsRecheck('t', TIP, 'refs/remotes/origin/main'));
    await act(async () => {});
    expect(h.result.current[0].status).toBe('none');
    const calls = api.mergeBase.mock.calls.length;
    api.mergeBase.mockResolvedValue(BASE);
    let answer: unknown;
    let p!: Promise<unknown>;
    act(() => { p = h.result.current[1](); });
    await act(async () => { answer = await p; });
    expect(api.mergeBase.mock.calls.length).toBe(calls + 1);
    expect(answer).toMatchObject({ status: 'ready' });
    expect(h.result.current[0].status).toBe('ready');
  });

  it('a status-only graph update (the WIP row) does not re-ask; a refs change does', async () => {
    const graph = (wip: boolean, labels: unknown[]) => ({ rows: [...(wip ? [{ id: 'wip', wip: {} }] : []), { id: TIP, wip: null }], labels });
    const set = (g: unknown) => act(async () => { useRuntime.setState({ tabs: { t: { repo: { id: 4 }, graph: g } as never } } as never); });
    await set(graph(false, []));
    renderHook(() => useRangeStats('t', TIP, 'refs/remotes/origin/main'));
    await act(async () => {});
    const calls = api.mergeBase.mock.calls.length;
    await set(graph(true, []));
    expect(api.mergeBase.mock.calls.length).toBe(calls);
    await set(graph(true, [{ name: 'origin/f', row: 0 }]));
    expect(api.mergeBase.mock.calls.length).toBe(calls + 1);
  });
});
