import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'gitbolt.fileList.v1';

/** A fresh copy of the module, so the store reads storage the way it does at app start. */
async function fresh() {
  vi.resetModules();
  return import('./fileListPrefs');
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('file list prefs (feedback H31)', () => {
  it('Path/Tree and the sort survive a restart, under one versioned key; View all files does not', async () => {
    const first = await fresh();
    expect(first.useFileListPrefs.getState()).toMatchObject({ mode: 'path', sort: 'path', allFiles: false });
    first.useFileListPrefs.getState().set({ mode: 'tree' });
    first.useFileListPrefs.getState().set({ sort: 'status', allFiles: true });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ mode: 'tree', sort: 'status', advanceAfterStage: true });
    expect(Object.keys(localStorage)).toEqual([KEY]);

    const second = await fresh();
    expect(second.useFileListPrefs.getState()).toMatchObject({ mode: 'tree', sort: 'status', allFiles: false });
  });

  it('falls back to the defaults for corrupt or invalid stored data, field by field', async () => {
    for (const raw of ['{not json', 'null', '"tree"', '42', '[]']) {
      localStorage.setItem(KEY, raw);
      const { useFileListPrefs } = await fresh();
      expect(useFileListPrefs.getState(), raw).toMatchObject({ mode: 'path', sort: 'path', allFiles: false });
    }
    localStorage.setItem(KEY, JSON.stringify({ mode: 'tree', sort: 'size', allFiles: true }));
    const { useFileListPrefs, parseFileListPrefs } = await fresh();
    expect(useFileListPrefs.getState()).toMatchObject({ mode: 'tree', sort: 'path', allFiles: false });
    expect(parseFileListPrefs({ mode: 'list', sort: 'status' })).toEqual({ mode: 'path', sort: 'status', advanceAfterStage: true });
  });

  it('keeps working in memory when storage reads and writes throw', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { useFileListPrefs } = await fresh();
    expect(useFileListPrefs.getState()).toMatchObject({ mode: 'path', sort: 'path' });
    useFileListPrefs.getState().set({ mode: 'tree' });
    expect(useFileListPrefs.getState().mode).toBe('tree');
  });
});
