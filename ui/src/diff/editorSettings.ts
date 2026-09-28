import { create } from 'zustand';

/**
 * Editor settings that aren't toolbar prefs (those are `diffPrefs`). Plan 1C's settings screen
 * shows them; until then they persist here and have no UI.
 *
 * `stickyScroll` (H7) is off by default: the user's one exception to "every Monaco diff feature
 * stays on". Monaco's sticky scroll pops in after a file opens and is revealed (its widget updates
 * on a debounce after the first render, so it lands after the jump to the first change), and
 * with no language service its scopes come from indentation, so with PHP's brace-on-next-line
 * style the pinned line is the lone `{` under `function bar()`. Neither has a clean fix from
 * outside Monaco (see the lane V2 report).
 */
export interface EditorSettings { stickyScroll: boolean }
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { stickyScroll: false };

/** Plan 1C: the tooltip beside the sticky-scroll setting. */
export const STICKY_SCROLL_NOTE =
  "Sticky scroll pins the enclosing scope's first line. With brace-on-next-line styles (common in PHP) it may show only the brace; it can also appear a moment after a file opens.";

export const EDITOR_SETTINGS_STORAGE_KEY = 'gitbolt.editorSettings.v1';

/** Stored data → settings; anything invalid takes its default. */
export function parseEditorSettings(raw: unknown): EditorSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_EDITOR_SETTINGS;
  const r = raw as Record<string, unknown>;
  return { stickyScroll: typeof r.stickyScroll === 'boolean' ? r.stickyScroll : DEFAULT_EDITOR_SETTINGS.stickyScroll };
}

/**
 * THE persistence seam for editor settings: localStorage until plan 1C's settings store replaces
 * this one object. Every access is guarded; blocked or full storage keeps them in memory.
 */
export interface EditorSettingsPersistence { load(): EditorSettings; save(s: EditorSettings): void }
export const editorSettingsPersistence: EditorSettingsPersistence = {
  load: () => {
    try {
      const raw = globalThis.localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY);
      return raw === null ? DEFAULT_EDITOR_SETTINGS : parseEditorSettings(JSON.parse(raw));
    } catch {
      return DEFAULT_EDITOR_SETTINGS;
    }
  },
  save: (s) => {
    try {
      globalThis.localStorage.setItem(EDITOR_SETTINGS_STORAGE_KEY, JSON.stringify(s));
    } catch {
      // Blocked or full storage: in memory only.
    }
  },
};

interface EditorSettingsState { settings: EditorSettings; set(patch: Partial<EditorSettings>): void }

export const useEditorSettings = create<EditorSettingsState>((set) => ({
  settings: editorSettingsPersistence.load(),
  set: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      editorSettingsPersistence.save(settings);
      return { settings };
    }),
}));
