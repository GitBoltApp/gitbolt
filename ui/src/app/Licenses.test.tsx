import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: { appInfo: vi.fn(async () => ({ appVersion: '1.2.3', gitVersion: '2.45.0' })) },
}));

const { About, useAbout } = await import('./About');

const FILES: Record<string, string> = {
  'licenses/index.json': JSON.stringify({
    files: [
      { name: 'THIRD-PARTY-NOTICES-ui.txt', size: 900_000 },
      { name: 'LICENSE.txt', size: 1071 },
      { name: 'THIRD-PARTY-NOTICES-rust.txt', size: 177_000 },
      { name: 'DICTIONARY-en-US-LICENSE.txt', size: 16_900 },
      { name: 'CEF-LICENSE.txt', size: 1662 },
    ],
  }),
  'licenses/LICENSE.txt': 'MIT License\n\nCopyright (c) 2026 Francis Lavoie',
  'licenses/THIRD-PARTY-NOTICES-rust.txt': 'GitBolt: third-party notices for the Rust crates',
  'licenses/THIRD-PARTY-NOTICES-ui.txt': 'GitBolt: third-party notices for the UI',
  'licenses/CEF-LICENSE.txt': 'Marshall A. Greenblatt',
  'licenses/DICTIONARY-en-US-LICENSE.txt': 'Copyright 2000-2018 by Kevin Atkinson',
};

function mockFetch(files: Record<string, string> | null) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace(/^\//, '');
    const body = files?.[path];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
  });
}

describe('About > Open source licenses', () => {
  beforeEach(() => { vi.stubGlobal('fetch', mockFetch(FILES)); });
  afterEach(() => { useAbout.setState({ open: false }); vi.unstubAllGlobals(); });

  it("an index.html fallback (the asset protocol's answer for a missing file) shows as an error, not as text", async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('index.json')
      ? new Response(JSON.stringify({ files: [{ name: 'LICENSE.txt', size: 10 }] }), { status: 200 })
      : new Response('<html><head></head></html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    render(<About />);
    act(() => useAbout.getState().setOpen(true));
    fireEvent.click(screen.getByRole('button', { name: 'Open source licenses' }));
    expect(await screen.findByText("Couldn't load LICENSE.txt.")).toBeTruthy();
    expect(screen.queryByText(/<html>/)).toBeNull();
  });

  it('lists the notices the build ships, and shows the one picked', async () => {
    render(<About />);
    act(() => useAbout.getState().setOpen(true));
    fireEvent.click(screen.getByRole('button', { name: 'Open source licenses' }));

    const list = await screen.findByRole('list', { name: 'License files' });
    const names = [...list.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toEqual([
      expect.stringContaining('GitBolt'),
      expect.stringContaining('Interface'),
      expect.stringContaining('Rust crates'),
      expect.stringContaining('Chromium Embedded Framework'),
      expect.stringContaining('Spell-check dictionary'),
    ]);
    // The first file is shown right away.
    expect(await screen.findByText(/Copyright \(c\) 2026 Francis Lavoie/)).toBeTruthy();
    // Chromium's credits (about 20 MB) aren't in the app: where the package installs them.
    expect(screen.getByText(/\/usr\/share\/doc\/gitbolt\/CHROMIUM-CREDITS\.html\.gz/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Rust crates/ }));
    expect(await screen.findByText('GitBolt: third-party notices for the Rust crates')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Rust crates/ }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Spell-check dictionary/ }));
    expect(await screen.findByText('Copyright 2000-2018 by Kevin Atkinson')).toBeTruthy();

    // Back returns to the About page.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Version 1.2.3')).toBeTruthy();
  });

  it("on Windows, gives the credits' place in the install folder", async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    try {
      render(<About />);
      act(() => useAbout.getState().setOpen(true));
      fireEvent.click(screen.getByRole('button', { name: 'Open source licenses' }));
      expect(await screen.findByText('licenses\\CHROMIUM-CREDITS.html.gz')).toBeTruthy();
      expect(screen.queryByText(/\/usr\/share\/doc/)).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('says so when the build has no notices (a dev build)', async () => {
    vi.stubGlobal('fetch', mockFetch(null));
    render(<About />);
    act(() => useAbout.getState().setOpen(true));
    fireEvent.click(screen.getByRole('button', { name: 'Open source licenses' }));
    expect(await screen.findByText(/This build doesn't include the license notices/)).toBeTruthy();
  });

  it('opens on the About page again after closing', async () => {
    render(<About />);
    act(() => useAbout.getState().setOpen(true));
    fireEvent.click(screen.getByRole('button', { name: 'Open source licenses' }));
    await screen.findByRole('list', { name: 'License files' });
    act(() => useAbout.getState().setOpen(false));
    act(() => useAbout.getState().setOpen(true));
    expect(screen.getByRole('button', { name: 'Open source licenses' })).toBeTruthy();
  });
});
