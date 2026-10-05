import { describe, expect, it } from 'vitest';
import { chipStyle, chipText } from './chipStyle';

describe('chipStyle', () => {
  it('picks dark text on a light colour and white on a dark one', () => {
    expect(chipText('a2eeef')).toBe('#000');
    expect(chipText('#a2eeef')).toBe('#000');
    expect(chipText('0e8a16')).toBe('#fff');
    expect(chipText('#5319e7')).toBe('#fff');
  });

  it('sets the colour and its text, and nothing without a colour', () => {
    expect(chipStyle('#a2eeef')).toEqual({ '--chip-color': '#a2eeef', '--chip-text': '#000' });
    expect(chipStyle(null)).toBeUndefined();
    expect(chipStyle(undefined)).toBeUndefined();
  });
});
