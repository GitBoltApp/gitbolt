import { beforeEach, describe, expect, it } from 'vitest';
import { clampListW, LIST_W, loadListW, saveListW } from './listWidth';

describe('history list width', () => {
  beforeEach(() => localStorage.clear());
  it('defaults, clamps and round-trips', () => {
    expect(loadListW()).toBe(LIST_W.default);
    saveListW(9999);
    expect(loadListW()).toBe(LIST_W.max);
    saveListW(300);
    expect(loadListW()).toBe(300);
    localStorage.setItem(LIST_W.key, 'junk');
    expect(loadListW()).toBe(LIST_W.default);
    expect(clampListW(1)).toBe(LIST_W.min);
  });
});
