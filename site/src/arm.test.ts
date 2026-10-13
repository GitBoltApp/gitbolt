// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { armInPlace } from './arm.ts';

let button: HTMLButtonElement;
let other: HTMLButtonElement;
beforeEach(() => {
  document.body.innerHTML = '<button id="reset"></button><button id="other"></button>';
  button = document.querySelector('#reset')!;
  other = document.querySelector('#other')!;
});
const armed = () => button.classList.contains('armed');

test('the first click arms, the second runs and disarms', () => {
  const run = vi.fn();
  armInPlace(button, document, window, run);
  button.click();
  expect(armed()).toBe(true);
  expect(run).not.toHaveBeenCalled();
  button.click();
  expect(run).toHaveBeenCalledTimes(1);
  expect(armed()).toBe(false);
});

test('Esc, a press elsewhere, focus leaving it or the window (into the demo) disarm, with no timer', () => {
  vi.useFakeTimers();
  const run = vi.fn();
  armInPlace(button, document, window, run);
  for (const cancel of [
    () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    () => other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
    () => button.dispatchEvent(new FocusEvent('focusout')),
    () => window.dispatchEvent(new Event('blur')),
  ]) {
    button.click();
    vi.advanceTimersByTime(60_000);
    expect(armed()).toBe(true);
    cancel();
    expect(armed()).toBe(false);
  }
  expect(run).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('nothing to lose (the demo not up): one click runs', () => {
  const run = vi.fn();
  armInPlace(button, document, window, run, () => false);
  button.click();
  expect(run).toHaveBeenCalledTimes(1);
  expect(armed()).toBe(false);
});
