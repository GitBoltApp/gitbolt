import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ mergeBase: vi.fn(), fileList: vi.fn() }));
vi.mock('../../api/client', () => ({ api }));

const { useRangeStats, clearRangeStats } = await import('./rangeStats');
const { useRuntime } = await import('../../app/runtime');

const TIP = 't'.repeat(40);
const BASE = 'b'.repeat(40);

beforeEach(() => {
  clearRangeStats();
  api.mergeBase.mockReset().mockResolvedValue(BASE);
  api.fileList.mockReset().mockResolvedValue({ files: [{}, {}], added: 10, deleted: 3 });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 }, graph: { rows: [] } } as never } } as never);
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
});
