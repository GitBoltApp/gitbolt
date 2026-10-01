import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A deferred value that hasn't caught up yet (a busy main thread): `useDeferredValue` keeps
// returning the first value it saw, so the rendered results are still those of the empty query.
let stale: { v: unknown } | null = null;
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  const useDeferredValue = <T,>(v: T): T => (stale ??= { v }).v as T;
  return { ...react, default: { ...react, useDeferredValue }, useDeferredValue };
});

const openRepo = vi.fn();
const doThing = vi.fn();
vi.mock('./sources', () => ({
  actionEntries: () => [
    { id: 'action:open', group: 'action', label: 'Open repository…', run: openRepo },
    { id: 'action:thing', group: 'action', label: 'Do thing', run: doThing },
  ],
  refEntries: () => [],
  settingEntries: () => [],
  tabEntries: () => [],
  fileEntries: async () => [],
}));
vi.mock('../app/actions', () => ({ activeTab: () => null }));

const { Palette, usePalette } = await import('./Palette');

afterEach(() => { cleanup(); usePalette.getState().close(); stale = null; });

describe('Palette Enter', () => {
  it('runs the best match for what was typed, even before the deferred results caught up', async () => {
    render(<Palette />);
    act(() => usePalette.getState().show());
    const input = await screen.findByLabelText('Command palette query');
    fireEvent.change(input, { target: { value: 'thing' } });
    // The list still shows the empty query's results (Open repository… first)…
    expect(screen.getAllByRole('option')[0].textContent).toContain('Open repository');
    fireEvent.keyDown(input, { key: 'Enter' });
    // …but Enter answers the query as typed.
    expect(doThing).toHaveBeenCalledTimes(1);
    expect(openRepo).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
