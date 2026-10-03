import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const doThing = vi.hoisted(() => vi.fn());
vi.mock('./sources', () => ({
  actionEntries: () => [
    ...['Fetch', 'Pull', 'Push', 'Stash'].map((label) => ({ id: `action:${label}`, group: 'action', label, run: () => {} })),
    { id: 'action:x', group: 'action', label: 'Do thing', run: doThing },
  ],
  refEntries: () => [],
  settingEntries: () => [],
  tabEntries: () => [],
  fileEntries: async () => [],
}));
vi.mock('../app/actions', () => ({ activeTab: () => null }));

const { Palette, usePalette } = await import('./Palette');
const { registerKeys } = await import('../ui/keyRouter');

afterEach(() => { cleanup(); usePalette.getState().close(); });

describe('Palette keys', () => {
  it('Ctrl+W is swallowed and Esc closes it, and no app-layer handler sees either', async () => {
    const app = vi.fn(() => 'handled' as const);
    const off = registerKeys('app', app);
    render(<Palette />);
    act(() => usePalette.getState().show());
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Command palette query'), { key: 'w', code: 'KeyW', ctrlKey: true });
    expect(app).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Command palette query'), { key: 'Escape' });
    expect(app).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    off();
  });

  // Enter right after typing (debug.spec, under load): the narrowed list is committed and painted
  // by the deferred render, whose effects come in a later task. An Enter in between, with a row of
  // the previous list highlighted (hovered or arrowed to) past the new list's end, ran nothing.
  it('Enter between the narrowed list painting and its effects runs the row shown as active', async () => {
    render(<Palette />);
    act(() => usePalette.getState().show());
    const input = await screen.findByLabelText('Command palette query');
    fireEvent.pointerOver(screen.getAllByRole('option')[3]);
    expect(screen.getAllByRole('option')[3]).toHaveAttribute('aria-selected', 'true');
    const list = screen.getByRole('listbox');
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnv = env.IS_REACT_ACT_ENVIRONMENT;
    // React's own scheduling, as in the app: no act() flushing the effects with the commit.
    env.IS_REACT_ACT_ENVIRONMENT = false;
    let active: string | null | undefined;
    const seen = new MutationObserver(() => {
      if (active !== undefined || !list.textContent?.includes('Do thing') || list.textContent.includes('Fetch')) return;
      // The narrowed list just committed (this runs in a microtask after the DOM changed).
      active = list.querySelector('[aria-selected="true"]')?.textContent ?? null;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    seen.observe(list, { childList: true, subtree: true, characterData: true, attributes: true });
    try {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'thing');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(active).not.toBeUndefined());
      expect(active).toBe('Do thing');
      await vi.waitFor(() => expect(doThing).toHaveBeenCalledTimes(1));
    } finally {
      seen.disconnect();
      env.IS_REACT_ACT_ENVIRONMENT = actEnv;
    }
  });
});
