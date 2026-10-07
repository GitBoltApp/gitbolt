import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateRelease } from '../api/gen/UpdateRelease';
import type { UpdateState } from '../api/gen/UpdateState';

const api = vi.hoisted(() => ({
  updateStatus: vi.fn(async () => ({ state: 'idle' })),
  updateDownload: vi.fn(async () => ({ state: 'idle' })),
}));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));

const { UpdatePill } = await import('./UpdatePill');
const { useUpdates, resetUpdatesForTest } = await import('./store');
const { useAppInfo } = await import('../app/appInfo');
const { useAppState, DEFAULT_SETTINGS } = await import('../app/state');

const release: UpdateRelease = { version: '0.3.0', name: 'GitBolt 0.3.0', notes: '', url: 'https://github.example/r', prerelease: false, publishedAt: null, asset: { name: 'GitBolt_0.3.0_amd64.deb', size: 1000 } };
const set = (state: UpdateState) => act(() => useUpdates.getState().setState(state));
const pill = () => document.querySelector<HTMLButtonElement>('.sb-update');

describe('UpdatePill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpdatesForTest();
    useAppInfo.setState({ info: { appVersion: '0.2.0', build: null, gitVersion: '2.47.1', installKind: 'deb' } });
    useAppState.setState({ settings: { ...DEFAULT_SETTINGS } });
  });

  it('takes no room without an update, nor while checking, nor after a failed check', async () => {
    render(<UpdatePill />);
    await vi.waitFor(() => expect(api.updateStatus).toHaveBeenCalled());
    for (const s of [{ state: 'idle' }, { state: 'checking' }, { state: 'upToDate' }, { state: 'failed', message: 'offline', release: null }] as UpdateState[]) {
      set(s);
      expect(pill()).toBeNull();
    }
  });

  it('"Update to 0.3.0" starts the download', () => {
    render(<UpdatePill />);
    set({ state: 'available', release });
    expect(pill()).toHaveTextContent('Update to 0.3.0');
    fireEvent.click(pill()!);
    expect(api.updateDownload).toHaveBeenCalledTimes(1);
    expect(useUpdates.getState().dialogOpen).toBe(false);
  });

  it('a build from source, or an AUR install, opens the dialog instead', () => {
    useAppInfo.setState({ info: { appVersion: '0.2.0', build: null, gitVersion: '2.47.1', installKind: 'none' } });
    render(<UpdatePill />);
    set({ state: 'available', release: { ...release, asset: null } });
    fireEvent.click(pill()!);
    expect(useUpdates.getState().dialogOpen).toBe(true);
    act(() => useUpdates.getState().closeDialog());
    useAppInfo.setState({ info: { appVersion: '0.2.0', build: null, gitVersion: '2.47.1', installKind: 'arch' } });
    act(() => useAppState.setState({ settings: { ...DEFAULT_SETTINGS, updateArchMethod: 'aur' } }));
    set({ state: 'available', release });
    fireEvent.click(pill()!);
    expect(useUpdates.getState().dialogOpen).toBe(true);
    expect(api.updateDownload).not.toHaveBeenCalled();
  });

  it('downloading: a progress bar, the percentage in its tooltip and label; the same width class', () => {
    render(<UpdatePill />);
    set({ state: 'downloading', release, received: 420, total: 1000 });
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(pill()).toHaveAccessibleName('Downloading GitBolt 0.3.0, 42%');
    fireEvent.mouseEnter(pill()!);
    expect(screen.getByText('Downloading GitBolt 0.3.0: 42%')).toBeInTheDocument();
    fireEvent.click(pill()!);
    expect(useUpdates.getState().dialogOpen).toBe(true);
  });

  it('ready: "Install 0.3.0" opens the dialog; installed offers the restart; a failure says so', () => {
    render(<UpdatePill />);
    set({ state: 'ready', release });
    expect(pill()).toHaveTextContent('Install 0.3.0');
    fireEvent.click(pill()!);
    expect(useUpdates.getState().dialogOpen).toBe(true);
    set({ state: 'installed', release });
    expect(pill()).toHaveTextContent('Restart to update');
    set({ state: 'failed', message: "The download doesn't match its checksum", release });
    expect(pill()).toHaveTextContent('Update failed');
    expect(pill()).toHaveClass('failed');
    fireEvent.mouseEnter(pill()!);
    expect(screen.getByText("The download doesn't match its checksum")).toBeInTheDocument();
  });
});
