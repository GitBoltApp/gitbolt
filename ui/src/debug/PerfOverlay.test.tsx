import { act, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { timed, type Transport } from '../api/transport';

const inner: Transport = { call: async () => [], subscribe: () => () => {} };
// The Commands tab's poll goes through the real timing transport, as in the app.
const api = vi.hoisted(() => ({ commandLog: vi.fn() }));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));

const { recordCall } = await import('./calls');
const { PerfOverlay } = await import('./PerfOverlay');
const { CommandLogView } = await import('./CommandLogView');
const { useActivityUi } = await import('../app/activityLog');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  act(() => useActivityUi.setState({ perfOverlay: false }));
});

it('shows only when toggled, with the latest backend calls first, and stops its frame loop when hidden', () => {
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(7);
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  render(<PerfOverlay />);
  expect(screen.queryByRole('region', { name: 'Performance' })).toBeNull();
  expect(raf).not.toHaveBeenCalled();
  act(() => useActivityUi.getState().togglePerfOverlay());
  act(() => { recordCall({ method: 'graph', ms: 12.3, ok: true, at: 1 }); recordCall({ method: 'status', ms: 1.1, ok: false, at: 2 }); });
  const overlay = screen.getByRole('region', { name: 'Performance' });
  const rows = overlay.querySelectorAll('tbody tr');
  expect(rows[0]).toHaveTextContent('status');
  expect(rows[0]).toHaveClass('failed');
  expect(rows[1]).toHaveTextContent('graph');
  expect(rows[1]).toHaveTextContent('12.3 ms');
  expect(overlay).toHaveTextContent(/fps/i);
  act(() => useActivityUi.getState().togglePerfOverlay());
  expect(screen.queryByRole('region', { name: 'Performance' })).toBeNull();
  expect(cancel).toHaveBeenCalledWith(7);
});

it("lists none of the Debug tools' own calls, and their polling doesn't re-render it: no feedback loop", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1); // no frame windows: only calls can re-render it
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const t = timed(inner);
  api.commandLog.mockImplementation(() => t.call({ method: 'commandLog' }));
  act(() => useActivityUi.setState({ perfOverlay: true }));
  let renders = 0;
  render(
    <>
      <Profiler id="perf" onRender={() => { renders++; }}><PerfOverlay /></Profiler>
      <CommandLogView focusId={null} />
    </>,
  );
  await act(async () => { await Promise.resolve(); });
  const base = renders;
  // Ten seconds of the open Commands tab polling, plus the action log's and modal's own calls.
  for (let i = 0; i < 10; i++) {
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    await act(async () => { await t.call({ method: 'logFrontend', params: { level: 'info', message: 'x', stack: null } }); await t.call({ method: 'logsDir' }); await t.call({ method: 'diagnostics', params: { ui: {} as never } }); });
  }
  expect(api.commandLog).toHaveBeenCalledTimes(11);
  expect(renders).toBe(base);
  const overlay = screen.getByRole('region', { name: 'Performance' });
  for (const m of ['commandLog', 'logFrontend', 'logsDir', 'diagnostics']) expect(overlay).not.toHaveTextContent(m);
  // An app call still shows, with one render.
  await act(async () => { await t.call({ method: 'graph', params: { repo: 1, limit: null } }); });
  expect(renders).toBe(base + 1);
  expect(overlay.querySelector('tbody tr')).toHaveTextContent('graph');
});
