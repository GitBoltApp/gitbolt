import { describe, expect, it } from 'vitest';
import { firstChangedLine } from './firstChange';

describe('firstChangedLine (H9: the diff header opens at the first change)', () => {
  it('the first line of the new side that differs', () => {
    expect(firstChangedLine('a\nb\nc\n', 'a\nB\nc\n')).toBe(2);
    expect(firstChangedLine('a\nb\n', 'a\nb\nc\n')).toBe(3);
    expect(firstChangedLine('', 'new\nfile\n')).toBe(1);
  });

  it('lines removed at the end: the last line; no change: null', () => {
    expect(firstChangedLine('a\nb\nc\n', 'a\nb\n')).toBe(2);
    expect(firstChangedLine('a\n', '')).toBe(1);
    expect(firstChangedLine('same\n', 'same\n')).toBeNull();
  });
});
