import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'gitbolt.diffPrefs.v1';

/** A fresh copy of the module, so the store reads storage the way it does at app start. */
async function fresh() {
  vi.resetModules();
  return import('./diffPrefs');
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('diff prefs', () => {
  it('defaults to Inline with both toggles off and saves every change through the seam', async () => {
    const { DEFAULT_DIFF_PREFS, diffPrefsPersistence, useDiffPrefs } = await fresh();
    expect(useDiffPrefs.getState().prefs).toEqual(DEFAULT_DIFF_PREFS);
    expect(DEFAULT_DIFF_PREFS).toEqual({ mode: 'inline', ignoreWhitespace: false, wordWrap: false });
    const save = vi.spyOn(diffPrefsPersistence, 'save');
    useDiffPrefs.getState().set({ mode: 'split' });
    useDiffPrefs.getState().set({ wordWrap: true });
    expect(useDiffPrefs.getState().prefs).toEqual({ mode: 'split', ignoreWhitespace: false, wordWrap: true });
    expect(save).toHaveBeenLastCalledWith({ mode: 'split', ignoreWhitespace: false, wordWrap: true });
  });

  it('remembers the last mode and toggles app-wide under one versioned key', async () => {
    const first = await fresh();
    first.useDiffPrefs.getState().set({ mode: 'split', ignoreWhitespace: true });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ mode: 'split', ignoreWhitespace: true, wordWrap: false });
    expect(Object.keys(localStorage)).toEqual([KEY]);

    const second = await fresh();
    expect(second.useDiffPrefs.getState().prefs).toEqual({ mode: 'split', ignoreWhitespace: true, wordWrap: false });
  });

  it('falls back to the defaults for corrupt or invalid stored data', async () => {
    for (const raw of ['{not json', 'null', '"split"', '42', '[]']) {
      localStorage.setItem(KEY, raw);
      const { useDiffPrefs, DEFAULT_DIFF_PREFS } = await fresh();
      expect(useDiffPrefs.getState().prefs, raw).toEqual(DEFAULT_DIFF_PREFS);
    }
    // Field by field: a valid field survives, an invalid one takes its default, extras are dropped.
    localStorage.setItem(KEY, JSON.stringify({ mode: 'sideways', ignoreWhitespace: 'yes', wordWrap: true, extra: 1 }));
    const { useDiffPrefs } = await fresh();
    expect(useDiffPrefs.getState().prefs).toEqual({ mode: 'inline', ignoreWhitespace: false, wordWrap: true });
  });

  it('keeps working in memory when storage reads and writes throw', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { useDiffPrefs, DEFAULT_DIFF_PREFS } = await fresh();
    expect(useDiffPrefs.getState().prefs).toEqual(DEFAULT_DIFF_PREFS);
    useDiffPrefs.getState().set({ mode: 'hunk' });
    expect(useDiffPrefs.getState().prefs.mode).toBe('hunk');
  });

  it('keeps working when the storage object itself is unreachable', async () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      const { useDiffPrefs, DEFAULT_DIFF_PREFS } = await fresh();
      expect(useDiffPrefs.getState().prefs).toEqual(DEFAULT_DIFF_PREFS);
      useDiffPrefs.getState().set({ wordWrap: true });
      expect(useDiffPrefs.getState().prefs.wordWrap).toBe(true);
    } finally {
      Object.defineProperty(window, 'localStorage', desc);
    }
  });
});
