import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: { appInfo: vi.fn(async () => ({ appVersion: '1.2.3', gitVersion: '2.45.0' })) },
}));

const { About, useAbout } = await import('./About');

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
