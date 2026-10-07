import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallKind } from '../api/gen/InstallKind';
import type { UpdateRelease } from '../api/gen/UpdateRelease';
import type { UpdateState } from '../api/gen/UpdateState';

const api = vi.hoisted(() => ({
  updateDownload: vi.fn(async () => ({ state: 'idle' })),
  updateCancel: vi.fn(async () => ({ state: 'idle' })),
  updateInstall: vi.fn(async (): Promise<unknown> => ({ outcome: 'installed' })),
  updateRestart: vi.fn(async () => null),
  openUrl: vi.fn(async () => null),
  saveSettings: vi.fn(async () => null),
}));
const copyText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)), onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText, inTauri: () => false }));

const { UpdateDialog } = await import('./UpdateDialog');
const { useUpdates, resetUpdatesForTest } = await import('./store');
const { useAppInfo } = await import('../app/appInfo');
const { useAppState, DEFAULT_SETTINGS } = await import('../app/state');

const release: UpdateRelease = { version: '0.3.0', name: 'GitBolt 0.3.0', notes: '## Added\n\n- **Updates** from GitHub', url: 'https://github.example/GitBoltApp/gitbolt/releases/tag/v0.3.0', prerelease: false, publishedAt: null, asset: { name: 'GitBolt_0.3.0_amd64.deb', size: 98 * 1024 * 1024 } };

function open(kind: InstallKind, state: UpdateState) {
  useAppInfo.setState({ info: { appVersion: '0.2.0', build: null, gitVersion: '2.47.1', installKind: kind } });
  render(<UpdateDialog />);
  act(() => { useUpdates.getState().setState(state); useUpdates.getState().openDialog(); });
  return screen.getByRole('dialog', { name: 'Update to GitBolt 0.3.0' });
}
const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('UpdateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpdatesForTest();
    useAppState.setState({ settings: { ...DEFAULT_SETTINGS } });
  });

  it('shows the rendered notes, the package and its size, and View on GitHub', async () => {
    const d = open('deb', { state: 'ready', release });
    expect(await screen.findByRole('heading', { name: 'Added' })).toBeInTheDocument();
    expect(d.querySelector('.update-notes strong')).toHaveTextContent('Updates');
    expect(d).toHaveTextContent('GitBolt_0.3.0_amd64.deb · 98.0 MB');
    expect(d).toHaveTextContent('You have GitBolt 0.2.0.');
    fireEvent.click(button('View on GitHub'));
    expect(api.openUrl).toHaveBeenCalledWith(release.url);
    fireEvent.keyDown(d, { key: 'Escape' });
    expect(useUpdates.getState().dialogOpen).toBe(false);
  });

  it('deb: Install; a cancelled password prompt shows the command with Copy; installed offers Restart', async () => {
    open('deb', { state: 'ready', release });
    expect(screen.getByText(/installs the package with apt/)).toBeInTheDocument();
    api.updateInstall.mockResolvedValueOnce({ outcome: 'manual', command: 'sudo apt install /c/GitBolt_0.3.0_amd64.deb', reason: 'GitBolt couldn\'t get permission to install it.', output: null });
    await act(async () => { fireEvent.click(button('Install 0.3.0')); });
    expect(screen.getByRole('alert')).toHaveTextContent(/^GitBolt couldn't get permission to install it\.$/);
    expect(screen.queryByLabelText('Package manager output')).toBeNull();
    expect(screen.getByText('Run this in a terminal instead:')).toBeInTheDocument();
    expect(screen.getByText('sudo apt install /c/GitBolt_0.3.0_amd64.deb')).toBeInTheDocument();
    fireEvent.click(button('Copy sudo apt install /c/GitBolt_0.3.0_amd64.deb'));
    expect(copyText).toHaveBeenCalledWith('sudo apt install /c/GitBolt_0.3.0_amd64.deb');
    // A failed apt: its output apart from the reason, then the command.
    api.updateInstall.mockResolvedValueOnce({ outcome: 'manual', command: 'sudo apt install /c/GitBolt_0.3.0_amd64.deb', reason: 'The install failed (exit 100).', output: 'E: Sub-process /usr/bin/dpkg returned an error code (1)' });
    await act(async () => { fireEvent.click(button('Install 0.3.0')); });
    expect(screen.getByRole('alert')).toHaveTextContent(/^The install failed \(exit 100\)\.$/);
    expect(screen.getByLabelText('Package manager output')).toHaveTextContent('E: Sub-process /usr/bin/dpkg returned an error code (1)');
    act(() => useUpdates.getState().setState({ state: 'installed', release }));
    fireEvent.click(button('Restart GitBolt'));
    expect(api.updateRestart).toHaveBeenCalled();
  });

  it('arch: asks how, remembers the answer; pacman installs, an AUR helper shows its commands', () => {
    open('arch', { state: 'ready', release: { ...release, asset: { name: 'GitBolt-0.3.0-1-x86_64.pkg.tar.zst', size: 1000 } } });
    expect(screen.getByText(/How did you install GitBolt\?/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install 0.3.0' })).toBeNull();
    fireEvent.click(button('Install with pacman'));
    expect(useAppState.getState().settings.updateArchMethod).toBe('pacman');
    expect(button('Install with pacman')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/installs the package with pacman/)).toBeInTheDocument();
    fireEvent.click(button('Install 0.3.0'));
    expect(api.updateInstall).toHaveBeenCalled();
    fireEvent.click(button('I use an AUR helper'));
    expect(useAppState.getState().settings.updateArchMethod).toBe('aur');
    expect(screen.getByText(/If you installed GitBolt from the AUR/)).toBeInTheDocument();
    expect(screen.getByText('yay -S gitbolt-bin')).toBeInTheDocument();
    expect(screen.getByText('paru -S gitbolt-bin')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install 0.3.0' })).toBeNull();
  });

  it.each([['nsis', /installer opens, and GitBolt closes/], ['msi', /Windows Installer opens/]] as const)('%s: Install starts the installer and says GitBolt closes', (kind, note) => {
    open(kind, { state: 'ready', release: { ...release, asset: { name: kind === 'msi' ? 'GitBolt_0.3.0_x64.msi' : 'GitBolt_0.3.0_x64-setup.exe', size: 1000 } } });
    expect(screen.getByText(note)).toBeInTheDocument();
    fireEvent.click(button('Install 0.3.0'));
    expect(api.updateInstall).toHaveBeenCalled();
  });

  it('a build from source offers only the release page', () => {
    const d = open('none', { state: 'available', release: { ...release, asset: null } });
    expect(d).toHaveTextContent('built from source');
    expect(screen.queryByRole('button', { name: /Download|Install/ })).toBeNull();
    expect(d.querySelector('.update-file')).toBeNull();
    expect(button('View on GitHub')).toBeInTheDocument();
  });

  it('available: Download; downloading: the percentage and Cancel; failed: why, and Download again', () => {
    open('deb', { state: 'available', release });
    fireEvent.click(button('Download'));
    expect(api.updateDownload).toHaveBeenCalledTimes(1);
    act(() => useUpdates.getState().setState({ state: 'downloading', release, received: 25, total: 100 }));
    expect(screen.getByRole('progressbar', { name: 'Download' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('25%')).toBeInTheDocument();
    fireEvent.click(button('Cancel'));
    expect(api.updateCancel).toHaveBeenCalled();
    act(() => useUpdates.getState().setState({ state: 'failed', message: "SHA256SUMS doesn't list GitBolt_0.3.0_amd64.deb, so GitBolt deleted the download and won't install it.", release }));
    expect(screen.getByText(/SHA256SUMS doesn't list/)).toBeInTheDocument();
    fireEvent.click(button('Download again'));
    expect(api.updateDownload).toHaveBeenCalledTimes(2);
  });

  it('a pre-release says so', () => {
    const d = open('deb', { state: 'available', release: { ...release, prerelease: true } });
    expect(d.querySelector('.update-badge')).toHaveTextContent('Pre-release');
  });
});
