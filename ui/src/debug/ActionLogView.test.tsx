import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const copyText = vi.hoisted(() => vi.fn(async (_t: string) => {}));
vi.mock('../api/client', () => ({ api: {}, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText, inTauri: () => false }));

const { ActionLogView } = await import('./ActionLogView');
const { useActionLog } = await import('./actionLog');

beforeEach(() => {
  useActionLog.getState().clear();
  copyText.mockClear();
});

it('lists actions newest first, live, with failures filterable and copyable (R11)', async () => {
  const rec = (id: string, label: string, ok: boolean, error: string | null = null, source: 'action' | 'menu' = 'action') =>
    useActionLog.getState().record({ at: Date.now(), id, label, ok, ms: 4, error, source });
  rec('view.zoomIn', 'Zoom in', true);
  render(<ActionLogView />);
  expect(document.querySelectorAll('li.debug-entry')).toHaveLength(1);
  act(() => rec('repo.fetch', 'Fetch all', false, 'denied'));
  act(() => rec('copy.sha', 'Copy SHA', true, null, 'menu'));
  const items = () => [...document.querySelectorAll('li.debug-entry')];
  expect(items()).toHaveLength(3);
  expect(items()[0]).toHaveTextContent('Copy SHA');
  expect(items()[0]).toHaveTextContent('menu');
  expect(items()[1]).toHaveTextContent('repo.fetch');
  expect(items()[1]).toHaveTextContent('denied');
  expect(items()[1]).toHaveClass('failed');
  fireEvent.click(screen.getByLabelText('Failed only'));
  expect(items()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
  await act(async () => { await Promise.resolve(); });
  expect(copyText.mock.calls[0][0]).toContain('denied');
  expect(copyText.mock.calls[0][0]).not.toContain('Zoom in');
});

it('says what it records while empty', () => {
  render(<ActionLogView />);
  expect(screen.getByText(/No actions yet/)).toBeInTheDocument();
});
