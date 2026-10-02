import { ArrowLeftToLine, ArrowRightToLine, Copy, CopyPlus, FileX, FolderOpen, FolderPlus, Info, LogOut, RotateCcw, X } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import type { Profile } from '../api/gen/Profile';
import { copyText, inTauri } from '../api/transport';
import { useToast } from '../ui/toast';
import { activeRuntime, activeStore, activeTab, registerActions } from './actions';
import { useAbout } from './About';
import { useOpenUi } from '../open/openUi';
import { flushSaves, useAppState } from './state';
import { guardTabClose } from '../diff/workingCopy';
import { closeTab, cycleTab, openBlankTab, reopenClosed } from './tabs';

/**
 * The shell's own actions: tabs (spec §6.2) and the current repo. Features register theirs in
 * their own modules (fetch, clone, find, the sidebar, settings, the palette), imported from
 * `features.ts`. The tab bar's own feature module (`tabs/features.ts`) registers the `header`
 * and `overlay` slots and the tab context menu; its actions live here.
 */
const update = (fn: (p: Profile) => Profile) => useAppState.getState().updateProfile(fn);
const repoTab = () => {
  const t = activeTab();
  return t?.kind === 'repo' && t.path ? t : null;
};
const tabCount = () => useAppState.getState().profile.tabs.length;

/** Ctrl+Shift+T and the tab menu's Reopen: the last closed tab, back where it was. */
export function reopenLastClosed(): void {
  const r = reopenClosed(useAppState.getState().profile);
  if (r) useAppState.getState().setProfile(r.profile);
}

/**
 * Shows `worktree`'s own folder in the file manager (the tab menu's "Open in file manager", and
 * `repo.openFolder`). There's no dedicated "open the repo root" request yet (preflight T8's
 * still-1C list), so this goes through the same `openIn` the file list uses: `path` only has to
 * be a syntactically valid single relative segment, since the core's `folder_target` (api.rs)
 * finds the containing folder by popping one segment off `worktree.join(path)` — which, for any
 * single segment, lands back on `worktree` itself.
 */
export function openRepoFolder(repoId: number, worktree: string): void {
  void api.openIn(repoId, { worktree, path: 'root', line: null, opener: 'file-manager', source: null, fallback: null })
    .catch((e: unknown) => useToast.getState().show(errorMessage(e)));
}

const off = registerActions([
  {
    id: 'file.openRepo', label: 'Open repository…', group: 'File', icon: FolderPlus, tooltip: 'Open the Open Repository screen in a new tab', shortcuts: ['Ctrl+O'],
    run: () => update((p) => openBlankTab(p).profile),
  },
  {
    id: 'file.clone', label: 'Clone repository…', group: 'File', icon: CopyPlus, tooltip: 'Clone a repository into a new tab',
    run: () => {
      const { profile, tabId } = openBlankTab(useAppState.getState().profile);
      useAppState.getState().setProfile(profile);
      useOpenUi.getState().requestClone(tabId);
    },
  },
  // Ctrl+W (ruling R6, the user's words: "close tab aka close repo, or close file like ESC if a
  // file is open"): with a file open it closes that file, else the tab — one or the other per
  // press, never both. Registered first, so it takes the chord while a file is open.
  {
    id: 'file.closeFile', label: 'Close file', group: 'File', icon: FileX, tooltip: 'Close the open file and go back to the graph', shortcuts: ['Ctrl+W'],
    when: () => activeStore()?.getState().diff != null,
    run: () => activeStore()?.getState().closeDiff(),
  },
  {
    id: 'file.closeTab', label: 'Close tab', group: 'File', icon: X, tooltip: 'Close the current tab', shortcuts: ['Ctrl+W'],
    when: () => !!activeTab(),
    run: () => {
      const t = activeTab();
      if (t) guardTabClose([t.id], () => update((p) => closeTab(p, t.id)));
    },
  },
  {
    id: 'file.reopenTab', label: 'Reopen closed tab', group: 'File', icon: RotateCcw, tooltip: 'Reopen the most recently closed tab', shortcuts: ['Ctrl+Shift+T'],
    when: () => useAppState.getState().profile.closedTabs.length > 0,
    run: reopenLastClosed,
  },
  // Only in the real app (Tauri): quitting a plain browser tab isn't a thing the harness can do,
  // and the hamburger must list only working actions.
  {
    id: 'file.quit', label: 'Quit', group: 'File', icon: LogOut, tooltip: 'Quit GitBolt',
    when: () => inTauri(),
    run: async () => {
      await flushSaves();
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    },
  },
  {
    id: 'view.nextTab', label: 'Next tab', group: 'View', icon: ArrowRightToLine, tooltip: 'Switch to the next tab', shortcuts: ['Ctrl+Tab', 'Ctrl+PageDown'],
    when: () => tabCount() > 1,
    run: () => update((p) => cycleTab(p, 1)),
  },
  {
    id: 'view.prevTab', label: 'Previous tab', group: 'View', icon: ArrowLeftToLine, tooltip: 'Switch to the previous tab', shortcuts: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'],
    when: () => tabCount() > 1,
    run: () => update((p) => cycleTab(p, -1)),
  },
  {
    id: 'repo.copyPath', label: 'Copy repository path', group: 'Repository', icon: Copy, tooltip: 'Copy the current repository\'s folder path',
    when: () => !!repoTab(),
    run: async () => {
      const t = repoTab();
      if (!t?.path) return;
      await copyText(t.path).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed'));
    },
  },
  {
    id: 'repo.openFolder', label: 'Open in file manager', group: 'Repository', icon: FolderOpen, tooltip: "Open the tab's worktree folder in the file manager",
    when: () => !!activeRuntime()?.repo,
    run: () => {
      // The tab's active worktree, not the repository's main one (spec #2 §11.2).
      const rt = activeRuntime();
      if (rt?.repo) openRepoFolder(rt.repo.id, rt.worktree ?? rt.repo.path);
    },
  },
  {
    id: 'help.about', label: 'About GitBolt', group: 'Help', icon: Info, tooltip: 'Version information',
    run: () => useAbout.getState().setOpen(true),
  },
]);
// A dev-server hot update re-runs this module: release the old registrations first, or the
// new ones throw "already registered".
import.meta.hot?.dispose(off);
