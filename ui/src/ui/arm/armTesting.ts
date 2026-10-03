import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { SETTLE_MS } from './store';

/** Tests only: a frozen `performance.now()` the test moves past the settle guard. */
export function armClock(): { settle(): void; advance(ms: number): void; restore(): void } {
  const clock = { t: 100_000 };
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  return { settle: () => { clock.t += SETTLE_MS + 1; }, advance: (ms) => { clock.t += ms; }, restore: () => spy.mockRestore() };
}

/** A real single click: its press, then the click (`detail` 1). */
export function press(el: Element): void {
  fireEvent.pointerDown(el);
  fireEvent.click(el, { detail: 1 });
}

/** Enter on a focused button: a fresh keydown, then its click (`detail` 0). */
export function pressEnter(el: Element, repeat = false): void {
  fireEvent.keyDown(el, { key: 'Enter', repeat });
  fireEvent.click(el, { detail: 0 });
}
