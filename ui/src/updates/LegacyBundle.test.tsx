import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArmLayer } from '../ui/arm/ArmLayer';
import { armClock, press } from '../ui/arm/armTesting';
import { disarm } from '../ui/arm/store';

const api = vi.hoisted(() => ({ updateRemoveLegacyBundle: vi.fn(async () => null), appInfo: vi.fn() }));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)), onEvent: () => () => {} }));

const { LegacyBundleNotice, LegacyBundleRow, LEGACY_NOTICE_KEY } = await import('./LegacyBundle');
const { useAppInfo } = await import('../app/appInfo');

const info = (legacyBundle: string | null) => ({ appVersion: '0.7.0', build: null, gitVersion: '2.47.1', installKind: 'dmg' as const, home: '/Users/ada', legacyBundle });
const overlay = () => document.querySelector<HTMLElement>('[data-arm-overlay]');
let clock: ReturnType<typeof armClock>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  disarm();
  clock?.restore();
  clock = armClock();
  api.appInfo.mockResolvedValue(info('/Applications/GitBolt.app'));
  useAppInfo.setState({ info: info('/Applications/GitBolt.app') });
});

describe('the GitBolt.app left beside GitVolt.app', () => {
  it('Remove arms in place with the red label, and the second click moves it to the Trash', async () => {
    render(<><LegacyBundleRow /><ArmLayer /></>);
    expect(screen.getByText(/GitBolt\.app, this app's old version, is still in \/Applications\./)).toBeInTheDocument();
    press(screen.getByRole('button', { name: 'Remove GitBolt.app' }));
    expect(overlay()).toHaveTextContent('Move GitBolt.app to the Trash');
    expect(api.updateRemoveLegacyBundle).not.toHaveBeenCalled();
    clock.settle();
    press(overlay()!);
    await waitFor(() => expect(api.updateRemoveLegacyBundle).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/still in/)).toBeNull());
  });

  it('Esc or a click elsewhere cancels, and nothing is removed', () => {
    render(<><LegacyBundleRow /><p>elsewhere</p><ArmLayer /></>);
    press(screen.getByRole('button', { name: 'Remove GitBolt.app' }));
    expect(overlay()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(overlay()).toBeNull();
    press(screen.getByRole('button', { name: 'Remove GitBolt.app' }));
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    fireEvent.click(screen.getByText('elsewhere'), { detail: 1 });
    expect(overlay()).toBeNull();
    expect(api.updateRemoveLegacyBundle).not.toHaveBeenCalled();
  });

  it("the core's refusal shows in the row, and the row stays", async () => {
    api.updateRemoveLegacyBundle.mockRejectedValueOnce(new Error('GitBolt is still running: quit it, then remove GitBolt.app'));
    render(<><LegacyBundleRow /><ArmLayer /></>);
    press(screen.getByRole('button', { name: 'Remove GitBolt.app' }));
    clock.settle();
    press(overlay()!);
    expect(await screen.findByRole('alert')).toHaveTextContent('GitBolt is still running');
    expect(screen.getByRole('button', { name: 'Remove GitBolt.app' })).toBeEnabled();
  });

  it('there is no row, and no notice, without a leftover bundle', () => {
    useAppInfo.setState({ info: info(null) });
    const { container } = render(<><LegacyBundleRow /><LegacyBundleNotice /></>);
    expect(container).toBeEmptyDOMElement();
  });

  it('the notice shows once: Keep closes it for good, and the settings row stays', () => {
    const first = render(<><LegacyBundleNotice /><LegacyBundleRow /></>);
    expect(screen.getByRole('region', { name: 'GitBolt.app is still installed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(localStorage.getItem(LEGACY_NOTICE_KEY)).not.toBeNull();
    first.unmount();
    render(<><LegacyBundleNotice /><LegacyBundleRow /></>);
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Remove GitBolt.app' })).toHaveLength(1);
    expect(api.updateRemoveLegacyBundle).not.toHaveBeenCalled();
  });

  it('removing from the notice closes it', async () => {
    render(<><LegacyBundleNotice /><ArmLayer /></>);
    press(screen.getByRole('button', { name: 'Remove GitBolt.app' }));
    clock.settle();
    press(overlay()!);
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    expect(api.updateRemoveLegacyBundle).toHaveBeenCalledTimes(1);
    act(() => disarm());
  });
});
