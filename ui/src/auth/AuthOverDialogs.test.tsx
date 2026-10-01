import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authAnswer = vi.fn(async (..._a: unknown[]) => null as unknown);
vi.mock('../api/client', () => ({ api: { authAnswer: (...a: unknown[]) => authAnswer(...a) }, onEvent: () => () => {} }));
const run = vi.fn();
vi.mock('../palette/sources', () => ({
  actionEntries: () => [{ id: 'action:thing', group: 'action', label: 'Do thing', run }],
  refEntries: () => [],
  settingEntries: () => [],
  tabEntries: () => [],
  fileEntries: async () => [],
}));
vi.mock('../app/appInfo', () => ({ useAppInfo: Object.assign((sel: (s: unknown) => unknown) => sel({ info: null }), { getState: () => ({ load: async () => {} }) }) }));
vi.mock('../app/actions', () => ({ activeTab: () => null }));

const { AuthModal } = await import('./AuthModal');
const { useOps } = await import('../app/ops');
const { Palette, usePalette } = await import('../palette/Palette');
const { About, useAbout } = await import('../app/About');
const { useModalKeys } = await import('../app/modalKeys');

const ask = (prompt: number) =>
  act(() => useOps.getState().apply({ type: 'authWaiting', prompt, op: 1, repo: null, text: 'Enter passphrase for key: ', secret: true }));
const resolve = (prompt: number) => act(() => useOps.getState().apply({ type: 'authResolved', prompt }));

beforeEach(() => {
  authAnswer.mockClear();
  run.mockClear();
  useOps.setState({ ops: {}, prompts: [], errors: [], unread: 0 });
});
afterEach(() => {
  cleanup();
  usePalette.getState().close();
  useAbout.getState().setOpen(false);
});

describe('an auth prompt that opens over another dialog', () => {
  it('over the Palette: takes the focus; Enter submits the prompt only, Esc cancels it only', async () => {
    render(<><Palette /><AuthModal /></>);
    act(() => usePalette.getState().show());
    const query = await screen.findByLabelText('Command palette query');
    fireEvent.change(query, { target: { value: 'thing' } });
    ask(1);
    const field = screen.getByLabelText('Password');
    expect(field).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Authentication required' }).parentElement).toHaveClass('auth-backdrop');

    fireEvent.change(field, { target: { value: 'pw' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(run).not.toHaveBeenCalled(); // the palette's Enter did not run its entry
    fireEvent.submit(field.closest('form')!);
    expect(authAnswer).toHaveBeenLastCalledWith(1, 'pw');

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(authAnswer).toHaveBeenLastCalledWith(1, null);
    expect(usePalette.getState().open).toBe(true); // Esc did not also close the palette

    // With the prompt gone, the palette owns its keys again.
    resolve(1);
    fireEvent.keyDown(query, { key: 'Enter' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('over an open dialog: Esc reaches the prompt only; the dialog is left open and works again after', () => {
    render(<><About /><AuthModal /></>);
    act(() => useAbout.getState().setOpen(true));
    ask(2);
    const field = screen.getByLabelText('Password');
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(authAnswer).toHaveBeenCalledTimes(1);
    expect(useAbout.getState().open).toBe(true);
    resolve(2);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useAbout.getState().open).toBe(false);
  });

  it('a dialog that re-renders with a new inline close stays under the prompt (final re-review N1)', () => {
    const closed = vi.fn();
    function Busy({ tick }: { tick: number }) {
      const ref = useModalKeys<HTMLDivElement>(true, () => closed(tick));
      return <div ref={ref} role="dialog" aria-label="Busy"><button type="button">x</button></div>;
    }
    const { rerender } = render(<><Busy tick={0} /><AuthModal /></>);
    ask(3);
    rerender(<><Busy tick={1} /><AuthModal /></>); // e.g. the Activity log on a new op
    const field = screen.getByLabelText('Password');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(authAnswer).toHaveBeenLastCalledWith(3, null);
    expect(closed).not.toHaveBeenCalled();
    resolve(3);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closed).toHaveBeenCalledWith(1); // the latest close
  });
});
