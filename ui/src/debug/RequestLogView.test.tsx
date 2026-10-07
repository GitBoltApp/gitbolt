import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestLogEntry } from '../api/gen/RequestLogEntry';
import { useActivityUi } from '../app/activityLog';

const requestLog = vi.hoisted(() => vi.fn(async (): Promise<RequestLogEntry[]> => []));
const copyText = vi.hoisted(() => vi.fn(async (_t: string) => {}));
vi.mock('../api/client', () => ({ api: { requestLog }, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText, inTauri: () => false }));

const { RequestLogView, filterRequests, requestText, durationText } = await import('./RequestLogView');

const r = (id: number, method: string, durationMs: number, error: RequestLogEntry['error'] = null, extra: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  id, method, params: 'repo=1', startedMs: 1_767_225_600_000 + id, durationMs, error, errorMessage: error ? 'no such repository' : null, commands: [], ...extra,
});
const entries = [
  r(1, 'graph', 42.5, null, { commands: [7, 8] }),
  r(2, 'commitDetails', 0.31, null, { params: 'repo=1 id=abc123' }),
  r(3, 'fileContents', 250, 'InvalidInput', { params: 'repo=1 path=src/a.rs' }),
  r(4, 'forgeMrDetail', 812.4, null, { params: 'repo=1 remote=origin number=42' }),
];

describe('the Requests tab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestLog.mockReset();
    requestLog.mockResolvedValue(entries);
    copyText.mockClear();
    useActivityUi.setState({ open: true, view: 'requests', focusCommandId: null });
  });
  afterEach(() => vi.useRealTimers());

  it('filters by text across method, params and error, by failure, and by slowness', () => {
    expect(filterRequests(entries, 'graph', false, false).map((x) => x.id)).toEqual([1]);
    expect(filterRequests(entries, 'NUMBER=42', false, false).map((x) => x.id)).toEqual([4]);
    expect(filterRequests(entries, 'no such', false, false).map((x) => x.id)).toEqual([3]);
    expect(filterRequests(entries, 'invalidinput', false, false).map((x) => x.id)).toEqual([3]);
    expect(filterRequests(entries, '', true, false).map((x) => x.id)).toEqual([3]);
    expect(filterRequests(entries, '', false, true).map((x) => x.id)).toEqual([3, 4]);
    expect(filterRequests(entries, '', true, true).map((x) => x.id)).toEqual([3]);
    expect(filterRequests([r(5, 'x', 100)], '', false, true)).toHaveLength(0); // above 100 ms only
    expect(filterRequests(entries, '', false, false)).toHaveLength(4);
  });

  it('writes durations to a tenth of a millisecond when short', () => {
    expect(durationText(0.31)).toBe('0.3 ms');
    expect(durationText(42.5)).toBe('43 ms');
    expect(durationText(1520)).toBe('1.5 s');
  });

  it('copies an entry with its outcome and git commands', () => {
    const text = requestText(entries[0]!, entries[0]!.startedMs);
    expect(text).toContain('#1');
    expect(text).toContain('graph repo=1');
    expect(text).toContain('ok');
    expect(text).toContain('git commands: #7, #8');
    expect(requestText(entries[2]!, 0)).toContain('InvalidInput: no such repository');
  });

  it('shows newest first, filters, opens a linked git command, and polls each second while shown', async () => {
    const { unmount } = render(<RequestLogView />);
    await act(async () => { await Promise.resolve(); });
    const items = () => [...document.querySelectorAll('li.debug-request')];
    expect(items()).toHaveLength(4);
    expect(items()[0]).toHaveTextContent('forgeMrDetail');
    expect(items()[0]).toHaveTextContent('number=42');
    expect(items()[3]).toHaveTextContent('graph');
    // A failed request opens expanded, with its error.
    expect(items()[1]).toHaveTextContent('no such repository');

    fireEvent.click(screen.getByLabelText('Slow only'));
    expect(items()).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('Failed only'));
    expect(items()).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Slow only'));
    fireEvent.click(screen.getByLabelText('Failed only'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter requests' }), { target: { value: 'graph' } });
    expect(items()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
    await act(async () => { await Promise.resolve(); });
    expect(copyText.mock.calls[0]![0]).toContain('graph repo=1');
    expect(copyText.mock.calls[0]![0]).not.toContain('forgeMrDetail');

    // Expanded, the graph lists its git commands; one jumps to the Commands tab, focused on it.
    fireEvent.click(items()[0]!.querySelector('.debug-row-main')!);
    fireEvent.click(screen.getByRole('button', { name: 'Show git command #8' }));
    expect(useActivityUi.getState()).toMatchObject({ view: 'commands', focusCommandId: 8 });

    expect(requestLog).toHaveBeenCalledTimes(1);
    requestLog.mockResolvedValue([...entries, r(5, 'status', 3)]);
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    expect(requestLog).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter requests' }), { target: { value: '' } });
    expect(items()).toHaveLength(5);
    expect(items()[0]).toHaveTextContent('status');
    unmount();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(requestLog).toHaveBeenCalledTimes(2);
  });

  it('says when nothing has been requested yet', async () => {
    requestLog.mockResolvedValue([]);
    render(<RequestLogView />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('No requests yet')).toBeInTheDocument();
  });
});
