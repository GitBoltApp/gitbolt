import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'gitbolt.imageBackground.v1';

async function fresh() {
  vi.resetModules();
  return import('./background');
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('image background (H30)', () => {
  it('checkerboard by default; black, white and mid-grey too; the pick is remembered app-wide', async () => {
    const { IMAGE_BACKGROUNDS, useImageBackground } = await fresh();
    expect(IMAGE_BACKGROUNDS.map((b) => b.id)).toEqual(['checker', 'black', 'white', 'grey']);
    expect(useImageBackground.getState().background).toBe('checker');
    useImageBackground.getState().set('white');
    expect(localStorage.getItem(KEY)).toBe('white');
    expect((await fresh()).useImageBackground.getState().background).toBe('white');
  });

  it('an unknown stored value or blocked storage falls back to the checkerboard', async () => {
    localStorage.setItem(KEY, 'plaid');
    expect((await fresh()).useImageBackground.getState().background).toBe('checker');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { useImageBackground } = await fresh();
    expect(useImageBackground.getState().background).toBe('checker');
    expect(() => useImageBackground.getState().set('black')).not.toThrow();
    expect(useImageBackground.getState().background).toBe('black');
  });
});
