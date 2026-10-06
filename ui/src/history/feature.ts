import { History, User } from 'lucide-react';
import { lazy } from 'react';
import { activeStore, activeTab, registerActions } from '../app/actions';
import { tabIdOf, tabStore } from '../app/tabStores';
import { registerPlaceKind } from '../nav/history';
import { centerViewOf, raiseCenterView, registerCenterView } from '../repo/centerView';
import { registerStickyOpener, type DiffTarget, type RepoViewStore } from '../repo/store';
import { historyStartOf } from './fromDiff';
import type { FileHistoryArgs } from './model';
import { FILE_HISTORY, openFileHistory, showsStart } from './open';
import './menus';
import { registerKeyHints } from '../shortcuts/hints';

// Lazy: the view pulls in File View (Monaco) and Shiki's language registry, which stay out of
// the startup chunk (spec §10.3 of #1; `npm run build` checks it).
const FileHistory = lazy(() => import('./FileHistory').then((m) => ({ default: m.FileHistory })));
// Its sticky mode (UX) lasts as long as it's open.
const offView = registerCenterView<FileHistoryArgs>(FILE_HISTORY, FileHistory, { onClose: (tabId) => tabStore(tabId)?.getState().setStickyHistory(null) });
import.meta.hot?.dispose(offView);

/**
 * UX, sticky File History: a file opened while it's open (the right panel's click, Up/Down, Enter,
 * the step after a stage, the palette) opens in it too, from where the toolbar's buttons would
 * start it, Blame on or off as it was left. The same history already open just comes back on top.
 * A file with none (new in the working tree) shows as usual, its Diff View over File History,
 * which stays open underneath, so the mode holds for the next file.
 */
function followFile(store: RepoViewStore, target: DiffTarget): void {
  const tabId = tabIdOf(store);
  const mode = store.getState().stickyHistory;
  if (!tabId || !mode) return;
  const start = historyStartOf(store.getState(), target);
  if (!start) return;
  const open = centerViewOf(tabId);
  if (open?.kind === FILE_HISTORY && showsStart(open.props as FileHistoryArgs, start)) raiseCenterView(tabId);
  else openFileHistory(tabId, start, mode.blame, { follow: true });
}
// Registered outside `import.meta.hot?.dispose(…)`: with no `hot` (a build), the call and its
// arguments are skipped.
const offOpener = registerStickyOpener(followFile);
import.meta.hot?.dispose(offOpener);

// Spec #5 §3.4: File History is a navigation place; it's left in the mode its Blame toggle was in.
const offPlace = registerPlaceKind('history', {
  capture: (tabId, p) => {
    const mode = tabStore(tabId)?.getState().stickyHistory;
    return mode && mode.blame !== p.blame ? { ...p, blame: mode.blame } : null;
  },
  restore: async (tabId, p) => openFileHistory(tabId, { path: p.path, rev: p.rev, worktree: p.worktree }, p.blame),
});
import.meta.hot?.dispose(offPlace);

/** The open diff's file, as the toolbar's buttons would open it. */
function openFileStart() {
  const s = activeStore()?.getState();
  return s?.diff ? historyStartOf(s, s.diff) : null;
}
function openOpenFile(blame: boolean) {
  const start = openFileStart();
  const tab = activeTab();
  if (start && tab) openFileHistory(tab.id, start, blame);
}
const offActions = registerActions([
  { id: 'history.file', label: 'File history of the open file', group: 'View', icon: History, tooltip: 'Show the commits that changed the open file', menu: false, when: () => openFileStart() !== null, run: () => openOpenFile(false) },
  { id: 'history.blame', label: 'Blame the open file', group: 'View', icon: User, tooltip: 'Show who last changed each line of the open file', menu: false, when: () => openFileStart() !== null, run: () => openOpenFile(true) },
]);
import.meta.hot?.dispose(offActions);

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.fh.close', section: 'File history', label: 'Close file history', keys: ['Esc'], context: '(when not typing)', source: 'history/FileHistory.tsx' },
]);
