import { create } from 'zustand';

export type DiffMode = 'hunk' | 'inline' | 'split';
/** Spec #5 §3.3: how File View shows a Markdown file, app-wide. */
export type MarkdownView = 'rendered' | 'source';
/** What File History shows for the selected commit: the file at that version, or the changes it made. */
export type HistoryView = 'file' | 'changes';
export interface DiffPrefs { mode: DiffMode; ignoreWhitespace: boolean; wordWrap: boolean; markdownView: MarkdownView; historyView: HistoryView }
/** What the diff editor's options are built from (`diffEditorOptions`). */
export type EditorDiffPrefs = Pick<DiffPrefs, 'mode' | 'ignoreWhitespace' | 'wordWrap'>;
/** Inline by default (plan 1B amendment 3); Markdown rendered (spec #5 §3.3); File History on the
 * file (its first behaviour). The user's last pick is remembered app-wide. */
export const DEFAULT_DIFF_PREFS: DiffPrefs = { mode: 'inline', ignoreWhitespace: false, wordWrap: false, markdownView: 'rendered', historyView: 'file' };

const MODES: readonly DiffMode[] = ['hunk', 'inline', 'split'];

/** The one localStorage key for diff prefs. Bump the version if the stored shape changes. */
export const DIFF_PREFS_STORAGE_KEY = 'gitbolt.diffPrefs.v1';

/** Stored data → prefs. Anything that isn't an object is `null` (the store uses the defaults);
 * inside an object, each valid field is kept and each invalid or missing one takes its default. */
export function parseDiffPrefs(raw: unknown): DiffPrefs | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    mode: MODES.includes(r.mode as DiffMode) ? (r.mode as DiffMode) : DEFAULT_DIFF_PREFS.mode,
    ignoreWhitespace: typeof r.ignoreWhitespace === 'boolean' ? r.ignoreWhitespace : DEFAULT_DIFF_PREFS.ignoreWhitespace,
    wordWrap: typeof r.wordWrap === 'boolean' ? r.wordWrap : DEFAULT_DIFF_PREFS.wordWrap,
    markdownView: r.markdownView === 'source' || r.markdownView === 'rendered' ? r.markdownView : DEFAULT_DIFF_PREFS.markdownView,
    historyView: r.historyView === 'file' || r.historyView === 'changes' ? r.historyView : DEFAULT_DIFF_PREFS.historyView,
  };
}

/**
 * THE persistence seam for diff mode and toggles (spec §10.2: app-wide settings that persist).
 * Backed by localStorage until plan 1C replaces this one object with its settings store (its
 * `diffMode`, `ignoreWhitespace` and `wordWrap` fields). Storage can be missing, blocked or full:
 * every access is guarded, and the prefs then simply last as long as the window.
 */
export interface DiffPrefsPersistence { load(): DiffPrefs | null; save(prefs: DiffPrefs): void }
export const diffPrefsPersistence: DiffPrefsPersistence = {
  load: () => {
    try {
      const raw = globalThis.localStorage.getItem(DIFF_PREFS_STORAGE_KEY);
      return raw === null ? null : parseDiffPrefs(JSON.parse(raw));
    } catch {
      return null;
    }
  },
  save: (prefs) => {
    try {
      globalThis.localStorage.setItem(DIFF_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Blocked or full storage: keep the prefs in memory only.
    }
  },
};

interface DiffPrefsState { prefs: DiffPrefs; set(patch: Partial<DiffPrefs>): void }

export const useDiffPrefs = create<DiffPrefsState>((set) => ({
  prefs: diffPrefsPersistence.load() ?? DEFAULT_DIFF_PREFS,
  set: (patch) =>
    set((s) => {
      const prefs = { ...s.prefs, ...patch };
      diffPrefsPersistence.save(prefs);
      return { prefs };
    }),
}));
