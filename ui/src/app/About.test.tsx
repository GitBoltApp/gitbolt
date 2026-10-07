import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  appInfo: vi.fn(async () => ({ appVersion: '1.2.3', gitVersion: '2.45.0', build: null, installKind: 'deb' })),
  updateCheck: vi.fn(async (): Promise<unknown> => ({ state: 'upToDate' })),
}));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)), onEvent: () => () => {} }));

const { About, useAbout } = await import('./About');
const { useUpdates, resetUpdatesForTest } = await import('../updates/store');

describe('About: focus trap (fix round 1)', () => {
  afterEach(() => { useAbout.setState({ open: false }); });

  it('focuses Close on open, and returns focus to the opener on close (toggled, not remounted)', () => {
    render(
      <>
        <button type="button">Open About</button>
        <About />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Open About' });
    opener.focus();
    act(() => useAbout.getState().setOpen(true));

    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close); // autoFocus, not the opener

    act(() => useAbout.getState().setOpen(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('About: Check for updates', () => {
  afterEach(() => { useAbout.setState({ open: false }); resetUpdatesForTest(); });

  it('checks, and says up to date, available (Show update opens the dialog and closes About) or why it failed', async () => {
    render(<About />);
    act(() => useAbout.getState().setOpen(true));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check for updates' })); });
    expect(screen.getByRole('status')).toHaveTextContent('GitBolt is up to date.');
    api.updateCheck.mockRejectedValueOnce(new Error("Couldn't reach api.github.com"));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check for updates' })); });
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't check for updates: Couldn't reach api.github.com");
    const release = { version: '1.3.0', name: 'GitBolt 1.3.0', notes: '', url: 'u', prerelease: false, publishedAt: null, asset: null };
    api.updateCheck.mockResolvedValueOnce({ state: 'available', release });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check for updates' })); });
    expect(screen.getByRole('status')).toHaveTextContent('GitBolt 1.3.0 is available.');
    fireEvent.click(screen.getByRole('button', { name: 'Show update' }));
    expect(useUpdates.getState().dialogOpen).toBe(true);
    expect(useAbout.getState().open).toBe(false);
  });
});
