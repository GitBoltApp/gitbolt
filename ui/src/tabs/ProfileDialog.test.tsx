import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: { createProfile: vi.fn(async () => ({ id: 'w', name: 'Work', color: '#000' })), switchProfile: vi.fn(async () => ({ settings: {}, profile: {}, profiles: [] })), saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null) },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { useProfileDialog, ProfileDialog } = await import('./ProfileDialog');

describe('ProfileDialog: focus trap (fix round 1)', () => {
  afterEach(() => { useProfileDialog.setState({ mode: null }); });

  it('traps Tab/Shift+Tab inside the dialog and returns focus to the opener on close', () => {
    render(
      <>
        <button type="button">Opener</button>
        <ProfileDialog />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    act(() => useProfileDialog.getState().open('new'));

    const name = screen.getByLabelText('Profile name');
    expect(document.activeElement).toBe(name); // autoFocus wins over the trap's own fallback focus

    // The submit button is disabled (no name yet), so it isn't a Tab stop until it's filled in.
    fireEvent.change(name, { target: { value: 'Work' } });
    const create = screen.getByRole('button', { name: 'Create' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    create.focus();
    expect(fireEvent.keyDown(create, { key: 'Tab' })).toBe(false); // prevented: wraps
    expect(document.activeElement).toBe(name);

    expect(fireEvent.keyDown(name, { key: 'Tab', shiftKey: true })).toBe(false); // prevented: wraps back
    expect(document.activeElement).toBe(create);

    // An ordinary Tab in the middle of the dialog is left to the browser's own focus movement.
    cancel.focus();
    expect(fireEvent.keyDown(cancel, { key: 'Tab' })).toBe(true);

    expect(fireEvent.keyDown(create, { key: 'Escape' })).toBe(false);
    expect(useProfileDialog.getState().mode).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
