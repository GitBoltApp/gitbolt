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
    expect(DEFAULT_DIFF_PREFS).toEqual({ mode: 'inline', ignoreWhitespace: false, wordWrap: false, markdownView: 'rendered' });
    const save = vi.spyOn(diffPrefsPersistence, 'save');
    useDiffPrefs.getState().set({ mode: 'split' });
    useDiffPrefs.getState().set({ wordWrap: true });
    expect(useDiffPrefs.getState().prefs).toEqual({ mode: 'split', ignoreWhitespace: false, wordWrap: true, markdownView: 'rendered' });
    expect(save).toHaveBeenLastCalledWith({ mode: 'split', ignoreWhitespace: false, wordWrap: true, markdownView: 'rendered' });
  });

  it('remembers the last mode and toggles app-wide under one versioned key', async () => {
    const first = await fresh();
    first.useDiffPrefs.getState().set({ mode: 'split', ignoreWhitespace: true });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ mode: 'split', ignoreWhitespace: true, wordWrap: false, markdownView: 'rendered' });
    expect(Object.keys(localStorage)).toEqual([KEY]);

    const second = await fresh();
    expect(second.useDiffPrefs.getState().prefs).toEqual({ mode: 'split', ignoreWhitespace: true, wordWrap: false, markdownView: 'rendered' });
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
    expect(useDiffPrefs.getState().prefs).toEqual({ mode: 'inline', ignoreWhitespace: false, wordWrap: true, markdownView: 'rendered' });
  });

  it('markdownView (spec #5 §3.3): Rendered by default, kept app-wide; anything else stored reads as the default', async () => {
    const { parseDiffPrefs, useDiffPrefs } = await fresh();
    expect(parseDiffPrefs({ markdownView: 'source' })?.markdownView).toBe('source');
    expect(parseDiffPrefs({ markdownView: 'wysiwyg' })?.markdownView).toBe('rendered');
    expect(parseDiffPrefs({ mode: 'split' })?.markdownView).toBe('rendered');
    useDiffPrefs.getState().set({ markdownView: 'source' });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ markdownView: 'source' });
    // A restart reads it back.
    expect((await fresh()).useDiffPrefs.getState().prefs.markdownView).toBe('source');
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
