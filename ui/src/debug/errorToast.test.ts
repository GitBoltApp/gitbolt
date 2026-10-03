import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const copyText = vi.hoisted(() => vi.fn(async (_t: string) => {}));
vi.mock('../api/client', () => ({ api: {}, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText, inTauri: () => false }));

const { toastActionError } = await import('./errorToast');
const { useToast, LONG_TOAST_MS } = await import('../ui/toast');
const { useActivityUi } = await import('../app/activityLog');

const gb = (kind: string, commandId: number | null = null, message = 'm') => ({ kind, message, commandId, stderr: 'fatal: x' });
const labels = () => [useToast.getState().action, ...useToast.getState().actions].filter(Boolean).map((a) => a!.label);
const click = (label: string) => act(() => [...useToast.getState().actions].find((a) => a.label === label)!.run());

describe('failed user action → the toast (R12)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    copyText.mockClear();
    act(() => useToast.getState().dismiss());
    useActivityUi.setState({ open: false, view: 'activity', focusCommandId: null });
  });

  it('shows the describeError text for LONG_TOAST_MS, with Copy and Details', () => {
    vi.useFakeTimers();
    toastActionError(gb('Io', null, 'disk full'));
    expect(useToast.getState().message).toBe('File system error: disk full');
    expect(labels()).toEqual(['Copy error', 'Details']);
    vi.advanceTimersByTime(LONG_TOAST_MS - 1);
    expect(useToast.getState().message).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useToast.getState().message).toBeNull();
    vi.useRealTimers();
  });

  it('Details opens the Commands tab at the command, else the Actions tab', () => {
    toastActionError(gb('AuthFailed', 42, 'denied'));
    click('Details');
    expect(useActivityUi.getState()).toMatchObject({ open: true, view: 'commands', focusCommandId: 42 });
    toastActionError(gb('InvalidInput', null, 'bad name'));
    click('Details');
    expect(useActivityUi.getState()).toMatchObject({ open: true, view: 'actions', focusCommandId: null });
  });

  it('a context action (Retry/Refresh/Remove from recent) comes first, in place of Copy', () => {
    const retry = vi.fn();
    toastActionError(gb('AuthFailed', 7), { retry });
    expect(labels()).toEqual(['Retry', 'Details']);
    click('Retry');
    expect(retry).toHaveBeenCalledOnce();
    toastActionError(gb('NotFound', null), { removeRecent: vi.fn() });
    expect(labels()).toEqual(['Remove from recent', 'Details']);
  });

  it('Copy puts the title, message and stderr on the clipboard', async () => {
    toastActionError(gb('AuthFailed', null, 'denied'));
    click('Copy error');
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith('Authentication failed\ndenied\nfatal: x'));
  });

  it('Cancelled stays silent; anything thrown is described as Other', () => {
    toastActionError(gb('Cancelled'));
    expect(useToast.getState().message).toBeNull();
    toastActionError(new Error('boom'));
    expect(useToast.getState().message).toBe('Something went wrong: boom');
  });
});
