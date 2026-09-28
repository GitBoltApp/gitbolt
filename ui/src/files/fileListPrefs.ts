import { create } from 'zustand';
import type { FileOrder } from '../repo/store';
import { displayTargets, type FileListMode, type FileSort } from './fileTree';

/** What persists (feedback H31): Path/Tree and the sort. "View all files" is per-commit and
 * never stored. */
export interface StoredFileListPrefs { mode: FileListMode; sort: FileSort }
export const DEFAULT_FILE_LIST_PREFS: StoredFileListPrefs = { mode: 'path', sort: 'path' };

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

interface FileListPrefs extends StoredFileListPrefs { allFiles: boolean; set(patch: Partial<Pick<FileListPrefs, 'mode' | 'sort' | 'allFiles'>>): void }

/** Path/Tree and sort are app-wide and remembered across restarts (H31); View all files carries
 * over from commit to commit for the session only. */
export const useFileListPrefs = create<FileListPrefs>((set, get) => ({
  ...(fileListPrefsPersistence.load() ?? DEFAULT_FILE_LIST_PREFS),
  allFiles: false,
  set: (patch) => {
    const before = get();
    set(patch);
    const { mode, sort } = get();
    if (mode !== before.mode || sort !== before.sort) fileListPrefsPersistence.save({ mode, sort });
  },
}));

/** A section's files as its list displays them, for `openFirstFile` (Enter in the graph). */
export const displayedOrder: FileOrder = (files, spec) => {
  const { mode, sort } = useFileListPrefs.getState();
  return displayTargets(files, spec, mode, sort);
};
