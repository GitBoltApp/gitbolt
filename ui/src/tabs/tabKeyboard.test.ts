import { describe, expect, it } from 'vitest';
import { nextTabFocus } from './tabKeyboard';

describe('nextTabFocus', () => {
  it('moves by one, wrapping, on the arrow keys', () => {
    expect(nextTabFocus(3, 0, 'ArrowRight')).toBe(1);
    expect(nextTabFocus(3, 2, 'ArrowRight')).toBe(0);
    expect(nextTabFocus(3, 0, 'ArrowLeft')).toBe(2);
    expect(nextTabFocus(3, 1, 'ArrowLeft')).toBe(0);
  });

  it('Home and End go to the first and last tab', () => {
    expect(nextTabFocus(4, 2, 'Home')).toBe(0);
    expect(nextTabFocus(4, 0, 'End')).toBe(3);
  });

  it('ignores any other key, and an empty tab strip', () => {
    expect(nextTabFocus(3, 1, 'Enter')).toBeNull();
    expect(nextTabFocus(3, 1, ' ')).toBeNull();
    expect(nextTabFocus(0, 0, 'ArrowRight')).toBeNull();
  });
});
