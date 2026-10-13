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

describe('Palette pickers', () => {
  it("an action's picker lists only its entries, under its title, and Enter runs the one typed", async () => {
    const picked = vi.fn();
    const entries = ['vendor/parser', 'vendor/theme', 'lib/icons'].map((label) => ({ id: `submodule:${label}`, group: 'choice' as const, label, detail: 'checked out', run: () => picked(label) }));
    render(<Palette />);
    act(() => usePalette.getState().choose({ title: 'Submodules', placeholder: 'Open a submodule in a tab', entries }));
    const input = await screen.findByPlaceholderText('Open a submodule in a tab');
    expect(screen.getAllByRole('option').map((o) => o.querySelector('.palette-label')?.textContent)).toEqual(['vendor/parser', 'vendor/theme', 'lib/icons']);
    expect(screen.getByText('Submodules')).toBeTruthy();
    expect(screen.queryByText('Do thing')).toBeNull();
    fireEvent.change(input, { target: { value: 'theme' } });
    await vi.waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(picked).toHaveBeenCalledWith('vendor/theme');
    expect(usePalette.getState().open).toBe(false);
    act(() => usePalette.getState().close());
    // A prefix is only text in a picker; past 50 matches, the rest are counted.
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, group: 'choice' as const, label: `vendor/lib${i}`, run: () => {} }));
    act(() => usePalette.getState().choose({ title: 'Submodules', placeholder: 'Pick', entries: [...many, ...entries] }));
    const pickInput = await screen.findByPlaceholderText('Pick');
    expect(screen.getAllByRole('option')).toHaveLength(50);
    expect(screen.getByText('13 more: type to narrow them down')).toBeTruthy();
    fireEvent.change(pickInput, { target: { value: '/theme' } });
    await vi.waitFor(() => expect(screen.getAllByRole('option').map((o) => o.querySelector('.palette-label')?.textContent)).toEqual(['vendor/theme']));
    expect(screen.queryByText(/more: type to narrow/)).toBeNull();
    act(() => usePalette.getState().close());
    // Ctrl+P afterwards is the whole palette again.
    act(() => usePalette.getState().show());
    expect(await screen.findByText('Do thing')).toBeTruthy();
  });
});
