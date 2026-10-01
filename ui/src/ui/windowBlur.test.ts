import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWindowBlur, refocusWhenWindowReturns } from './windowBlur';

describe('windowBlur (K41)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a blur while the document has no focus is the window losing it; with focus, a real move', () => {
    const has = vi.spyOn(document, 'hasFocus');
    has.mockReturnValue(false);
    expect(isWindowBlur()).toBe(true);
    has.mockReturnValue(true);
    expect(isWindowBlur()).toBe(false);
  });

  it('puts the caret back once the window returns, unless editing ended meanwhile', () => {
    const input = document.createElement('input');
    document.body.append(input);
    refocusWhenWindowReturns(input);
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(input);

    input.blur();
    let editing = true;
    refocusWhenWindowReturns(input, () => editing);
    editing = false;
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).not.toBe(input);
    input.remove();
  });
});
