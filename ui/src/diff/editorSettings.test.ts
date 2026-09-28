import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'gitbolt.editorSettings.v1';

async function fresh() {
  vi.resetModules();
  return import('./editorSettings');
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('editor settings (H7)', () => {
  it('sticky scroll is off by default, and a change is saved under one versioned key', async () => {
    const { DEFAULT_EDITOR_SETTINGS, useEditorSettings } = await fresh();
    expect(DEFAULT_EDITOR_SETTINGS).toEqual({ stickyScroll: false });
    expect(useEditorSettings.getState().settings).toEqual({ stickyScroll: false });
    useEditorSettings.getState().set({ stickyScroll: true });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ stickyScroll: true });
    const again = await fresh();
    expect(again.useEditorSettings.getState().settings).toEqual({ stickyScroll: true });
  });

  it('falls back to the defaults for corrupt data or blocked storage', async () => {
    for (const raw of ['{not json', 'null', '"x"', '[]', '{"stickyScroll":"yes"}']) {
      localStorage.setItem(KEY, raw);
      const { useEditorSettings } = await fresh();
      expect(useEditorSettings.getState().settings, raw).toEqual({ stickyScroll: false });
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { useEditorSettings } = await fresh();
    expect(useEditorSettings.getState().settings).toEqual({ stickyScroll: false });
    expect(() => useEditorSettings.getState().set({ stickyScroll: true })).not.toThrow();
    expect(useEditorSettings.getState().settings).toEqual({ stickyScroll: true });
  });

  it("keeps plan 1C's tooltip text for the setting", async () => {
    const { STICKY_SCROLL_NOTE } = await fresh();
    expect(STICKY_SCROLL_NOTE).toBe(
      "Sticky scroll pins the enclosing scope's first line. With brace-on-next-line styles (common in PHP) it may show only the brace; it can also appear a moment after a file opens.",
    );
  });
});
