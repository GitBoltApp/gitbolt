import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  queueState: vi.fn(async () => ({ running: null, queued: [], stopped: null })),
  queueRemove: vi.fn(async () => true),
  queueResume: vi.fn(async () => null),
  queueClear: vi.fn(async () => null),
  cancelOp: vi.fn(async () => null),
}));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));

const { QueueChip } = await import('./QueueChip');
const { useQueue } = await import('./store');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { useMenu } = await import('../menu/menuStore');

const item = (id: number, label: string) => ({ id, label, kind: 'push' as const, op: id + 100 });
const rowLabels = () => useMenu.getState().rows!.map((r) => (r.kind === 'action' ? r.label : '-'));
const run = (label: string) => {
  const row = useMenu.getState().rows!.find((r) => r.kind === 'action' && r.label === label);
  act(() => { if (row?.kind === 'action') row.run(); });
};

describe('QueueChip (spec #2 §3.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMenu.getState().close();
    useQueue.setState({ byRepo: {} });
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
    useRuntime.setState({ tabs: { t: { status: 'ready', error: null, repo: { id: 4, path: '/r', name: 'r', worktree: '/r' }, graph: null, info: null, sidebar: null, lastFetchAt: 0, fetchSkipped: null, limit: null, worktree: null } } });
  });

  it('is hidden while the queue is idle', () => {
    render(<QueueChip />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(api.queueState).toHaveBeenCalledWith(4);
  });

  it('opens the list: Cancel the running item, × a queued one', () => {
    act(() => useQueue.getState().set(4, { running: item(1, 'push dev'), queued: [item(2, 'commit "x"')], stopped: null }));
    render(<QueueChip />);
    fireEvent.click(screen.getByRole('button', { name: 'Running: push dev · 1 queued' }));
    expect(rowLabels()).toEqual(['Cancel push dev', 'Remove commit "x"']);
    run('Cancel push dev');
    expect(api.cancelOp).toHaveBeenCalledWith(101);
    run('Remove commit "x"');
    expect(api.queueRemove).toHaveBeenCalledWith(4, 2);
  });

  it('offers Resume and Clear after a stop', () => {
    act(() => useQueue.getState().set(4, { running: null, queued: [item(2, 'b')], stopped: { label: 'push dev', message: 'rejected' } }));
    render(<QueueChip />);
    fireEvent.click(screen.getByRole('button', { name: 'Stopped: push dev failed · 1 not run' }));
    expect(rowLabels()).toEqual(['Remove b', '-', 'Resume', 'Clear']);
    run('Resume');
    expect(api.queueResume).toHaveBeenCalledWith(4);
    run('Clear');
    expect(api.queueClear).toHaveBeenCalledWith(4);
  });
});
