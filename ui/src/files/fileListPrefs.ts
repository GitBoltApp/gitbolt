import { create } from 'zustand';
import type { FileOrder } from '../repo/store';
import { displayTargets, type FileListMode, type FileSort } from './fileTree';

/** What persists (feedback H31): Path/Tree and the sort. "View all files" is per-commit and
 * never stored. */
/** `advanceAfterStage`: after a whole-file stage, unstage or discard of the open file, the diff
 * moves to the next file in the section it left. */
export interface StoredFileListPrefs { mode: FileListMode; sort: FileSort; advanceAfterStage: boolean }
export const DEFAULT_FILE_LIST_PREFS: StoredFileListPrefs = { mode: 'path', sort: 'path', advanceAfterStage: true };

/** The one localStorage key for the file list's prefs. Bump the version if the shape changes. */
export const FILE_LIST_PREFS_STORAGE_KEY = 'gitbolt.fileList.v1';

const MODES: readonly FileListMode[] = ['path', 'tree'];
const SORTS: readonly FileSort[] = ['path', 'status'];

/** Stored data → prefs. Anything that isn't an object is `null` (the defaults); inside an
 * object, each valid field is kept and each invalid or missing one takes its default. */
export function parseFileListPrefs(raw: unknown): StoredFileListPrefs | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    mode: MODES.includes(r.mode as FileListMode) ? (r.mode as FileListMode) : DEFAULT_FILE_LIST_PREFS.mode,
    sort: SORTS.includes(r.sort as FileSort) ? (r.sort as FileSort) : DEFAULT_FILE_LIST_PREFS.sort,
    advanceAfterStage: typeof r.advanceAfterStage === 'boolean' ? r.advanceAfterStage : DEFAULT_FILE_LIST_PREFS.advanceAfterStage,
  };
}

/**
 * THE persistence seam for the file list's view (like `diffPrefsPersistence`): localStorage until
 * plan 1C's settings store replaces it. Storage can be missing, blocked or full: every access is
 * guarded, and the prefs then last as long as the window.
 */
export const fileListPrefsPersistence = {
  load(): StoredFileListPrefs | null {
    try {
      const raw = globalThis.localStorage.getItem(FILE_LIST_PREFS_STORAGE_KEY);
      return raw === null ? null : parseFileListPrefs(JSON.parse(raw));
    } catch {
      return null;
    }
  },
  save(prefs: StoredFileListPrefs) {
    try {
      globalThis.localStorage.setItem(FILE_LIST_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Blocked or full storage: keep the prefs in memory only.
    }
  },
};

/** `wipAllFiles`: the WIP row's own View all files (UX G.2), apart from the commits' one. */
interface FileListPrefs extends StoredFileListPrefs { allFiles: boolean; wipAllFiles: boolean; set(patch: Partial<Pick<FileListPrefs, 'mode' | 'sort' | 'advanceAfterStage' | 'allFiles' | 'wipAllFiles'>>): void }

/** Path/Tree and sort are app-wide and remembered across restarts (H31); View all files carries
 * over from commit to commit for the session only. */
export const useFileListPrefs = create<FileListPrefs>((set, get) => ({
  ...(fileListPrefsPersistence.load() ?? DEFAULT_FILE_LIST_PREFS),
  allFiles: false,
  wipAllFiles: false,
  set: (patch) => {
    const before = get();
    set(patch);
    const { mode, sort, advanceAfterStage } = get();
    if (mode !== before.mode || sort !== before.sort || advanceAfterStage !== before.advanceAfterStage) fileListPrefsPersistence.save({ mode, sort, advanceAfterStage });
  },
}));

/** A section's files as its list displays them, for `openFirstFile` (Enter in the graph). */
export const displayedOrder: FileOrder = (files, spec) => {
  const { mode, sort } = useFileListPrefs.getState();
  return displayTargets(files, spec, mode, sort);
};
