import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sources', () => ({
  actionEntries: () => [{ id: 'action:x', group: 'action', label: 'Do thing', run: () => {} }],
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
});
