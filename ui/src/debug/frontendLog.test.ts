import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useAppState } from '../app/state';
import { bindDebugLogging, installFrontendErrorLogging } from './frontendLog';

describe('installFrontendErrorLogging', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => uninstall?.());

  it('sends uncaught errors and unhandled rejections to the backend log', () => {
    const log = vi.fn(() => Promise.resolve(null));
    uninstall = installFrontendErrorLogging(log);
    const err = new Error('kaput');
    window.dispatchEvent(new ErrorEvent('error', { message: 'kaput', error: err }));
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.assign(rejection, { reason: { kind: 'Io', message: 'disk full', commandId: null, stderr: null } });
    window.dispatchEvent(rejection);
    expect(log).toHaveBeenNthCalledWith(1, 'error', 'kaput', err.stack ?? null);
    expect(log).toHaveBeenNthCalledWith(2, 'error', 'Unhandled rejection: disk full', null);
  });

  it('caps a flood at 20 reports per minute', () => {
    const log = vi.fn(() => Promise.resolve(null));
    let now = 0;
    uninstall = installFrontendErrorLogging(log, () => now);
    for (let i = 0; i < 50; i++) window.dispatchEvent(new ErrorEvent('error', { message: `e${i}` }));
    expect(log).toHaveBeenCalledTimes(20);
    now = 61_000;
    window.dispatchEvent(new ErrorEvent('error', { message: 'later' }));
    expect(log).toHaveBeenCalledTimes(21);
  });

  it('stops listening when uninstalled', () => {
    const log = vi.fn(() => Promise.resolve(null));
    installFrontendErrorLogging(log)();
    window.dispatchEvent(new ErrorEvent('error', { message: 'x' }));
    expect(log).not.toHaveBeenCalled();
  });
});

describe('bindDebugLogging', () => {
  it('pushes the setting to the backend when it changes, and only then', () => {
    const spy = vi.spyOn(api, 'setDebugLogging').mockResolvedValue(null);
    useAppState.setState({ settings: { ...useAppState.getState().settings, debugLogging: false } });
    const unbind = bindDebugLogging();
    expect(spy).not.toHaveBeenCalled();
    useAppState.setState({ settings: { ...useAppState.getState().settings, debugLogging: true } });
    expect(spy).toHaveBeenLastCalledWith(true);
    useAppState.setState({ settings: { ...useAppState.getState().settings, theme: 'x' } });
    expect(spy).toHaveBeenCalledTimes(1);
    useAppState.setState({ settings: { ...useAppState.getState().settings, debugLogging: false } });
    expect(spy).toHaveBeenLastCalledWith(false);
    unbind();
    spy.mockRestore();
  });
});
