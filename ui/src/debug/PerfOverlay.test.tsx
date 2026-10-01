import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: {}, errorMessage: String, onEvent: () => () => {} }));

const { recordCall } = await import('./calls');
const { PerfOverlay } = await import('./PerfOverlay');
const { useActivityUi } = await import('../app/activityLog');

it('shows only when toggled, with the latest backend calls first, and stops its frame loop when hidden', () => {
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(7);
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  render(<PerfOverlay />);
  expect(screen.queryByRole('region', { name: 'Performance' })).toBeNull();
  expect(raf).not.toHaveBeenCalled();
  act(() => useActivityUi.getState().togglePerfOverlay());
  act(() => { recordCall({ method: 'graph', ms: 12.3, ok: true, at: 1 }); recordCall({ method: 'commandLog', ms: 1.1, ok: false, at: 2 }); });
  const overlay = screen.getByRole('region', { name: 'Performance' });
  const rows = overlay.querySelectorAll('tbody tr');
  expect(rows[0]).toHaveTextContent('commandLog');
  expect(rows[0]).toHaveClass('failed');
  expect(rows[1]).toHaveTextContent('graph');
  expect(rows[1]).toHaveTextContent('12.3 ms');
  expect(overlay).toHaveTextContent(/fps/i);
  act(() => useActivityUi.getState().togglePerfOverlay());
  expect(screen.queryByRole('region', { name: 'Performance' })).toBeNull();
  expect(cancel).toHaveBeenCalledWith(7);
});
