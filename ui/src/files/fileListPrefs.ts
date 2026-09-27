import { create } from 'zustand';
import type { FileOrder } from '../repo/store';
import { displayTargets, type FileListMode, type FileSort } from './fileTree';

interface FileListPrefs { mode: FileListMode; sort: FileSort; allFiles: boolean; set(patch: Partial<Pick<FileListPrefs, 'mode' | 'sort' | 'allFiles'>>): void }

/** Path/Tree, sort and View-all-files carry over from commit to commit (session-wide). */
export const useFileListPrefs = create<FileListPrefs>((set) => ({ mode: 'path', sort: 'path', allFiles: false, set: (patch) => set(patch) }));

/** A section's files as its list displays them, for `openFirstFile` (Enter in the graph). */
export const displayedOrder: FileOrder = (files, spec) => {
  const { mode, sort } = useFileListPrefs.getState();
  return displayTargets(files, spec, mode, sort);
};
