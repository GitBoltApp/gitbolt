import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_TOAST_MS, TOAST_MS, toastDuration, useToast } from './toast';

describe('the toast duration policy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { useToast.getState().dismiss(); vi.useRealTimers(); });
  const shown = () => useToast.getState().message !== null;
  const link = { label: 'Go', run: () => {} };

  it('plain 4 s; links, warnings and errors 8 s; sticky none', () => {
    expect(toastDuration()).toBe(4000);
    expect(toastDuration({ action: link })).toBe(8000);
    expect(toastDuration({ actions: [link] })).toBe(8000);
    expect(toastDuration({ tone: 'warning' })).toBe(8000);
    expect(toastDuration({ error: true })).toBe(8000);
    expect(toastDuration({ sticky: true, tone: 'warning' })).toBeNull();
  });
  it('expires at the policy time', () => {
    useToast.getState().show('hi');
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(shown()).toBe(false);
    useToast.getState().show('bad', { error: true });
    vi.advanceTimersByTime(LONG_TOAST_MS - 1);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(shown()).toBe(false);
  });
  it('a sticky toast never times out', () => {
    useToast.getState().show('input', { sticky: true });
    vi.advanceTimersByTime(60_000);
    expect(shown()).toBe(true);
  });
  it('hover pauses the countdown and leave resumes with what was left', () => {
    useToast.getState().show('hi');
    vi.advanceTimersByTime(3000);
    useToast.getState().hold();
    vi.advanceTimersByTime(60_000);
    expect(shown()).toBe(true);
    useToast.getState().release();
    vi.advanceTimersByTime(999);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(shown()).toBe(false);
  });
});
