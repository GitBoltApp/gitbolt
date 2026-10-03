import { History, User } from 'lucide-react';
import { lazy } from 'react';
import { activeStore, activeTab, registerActions } from '../app/actions';
import { registerCenterView } from '../repo/centerView';
import { historyStartOf } from './fromDiff';
import type { FileHistoryArgs } from './model';
import { FILE_HISTORY, openFileHistory } from './open';
import './menus';

// Lazy: the view pulls in File View (Monaco) and Shiki's language registry, which stay out of
// the startup chunk (spec §10.3 of #1; `npm run build` checks it).
const FileHistory = lazy(() => import('./FileHistory').then((m) => ({ default: m.FileHistory })));
const offView = registerCenterView<FileHistoryArgs>(FILE_HISTORY, FileHistory);
import.meta.hot?.dispose(offView);

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
