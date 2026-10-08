import { FileCode, GitGraph, List, PanelLeft } from 'lucide-react';
import { activeStore, activeTab, registerActions } from '../app/actions';
import { useAppState } from '../app/state';
import { isMac } from '../ui/platformKeys';
import { leaveFileView, sidebarHidden } from './centerView';

/**
 * Alt+1…4 put the keyboard in a repo tab's zones, left to right: the sidebar, the graph, the
 * file list, the diff (`useFocusZone` focuses the zone on the store's request). Alt chords, so
 * they also get the keyboard out of a text box or the editor, which hold Tab. On macOS they're
 * ⌃1…4: Option+digit types a character there (¡ ™ £ ¢), and ⌘1…8 are the tabs.
 */
const store = () => (activeTab()?.kind === 'repo' ? activeStore() : null);
const zoneKey = (n: number) => `${isMac() ? 'Ctrl' : 'Alt'}+${n}`;

const off = registerActions([
  {
    id: 'view.focusSidebar', label: 'Focus the sidebar', group: 'View', icon: PanelLeft, tooltip: 'Put the keyboard in the sidebar', shortcuts: [zoneKey(1)], menu: false,
    when: () => { const t = activeTab(); return !!store() && !!t && !sidebarHidden(t.id); },
    // From its icon strip, or over a file view (UX R2.3), it expands first, as Filter sidebar does.
    run: () => {
      const t = activeTab();
      if (!t) return;
      leaveFileView(t.id);
      if (useAppState.getState().profile.sidebarNarrow) useAppState.getState().updateProfile((p) => ({ ...p, sidebarNarrow: false }));
      store()?.getState().setFocus('sidebar');
    },
  },
  {
    id: 'view.focusGraph', label: 'Focus the graph', group: 'View', icon: GitGraph, tooltip: 'Put the keyboard in the graph (closing the open file, as Esc does)', shortcuts: [zoneKey(2)], menu: false,
    when: () => !!store(),
    run: () => {
      const s = store()?.getState();
      if (s?.diff) s.closeDiff();
      else s?.setFocus('graph');
    },
  },
  {
    id: 'view.focusFiles', label: 'Focus the file list', group: 'View', icon: List, tooltip: 'Put the keyboard in the file list', shortcuts: [zoneKey(3)], menu: false,
    when: () => !!store()?.getState().panel,
    run: () => store()?.getState().setFocus('files'),
  },
  {
    id: 'view.focusDiff', label: 'Focus the diff', group: 'View', icon: FileCode, tooltip: 'Put the keyboard in the open file', shortcuts: [zoneKey(4)], menu: false,
    when: () => !!store()?.getState().diff,
    run: () => store()?.getState().setFocus('diff'),
  },
]);
import.meta.hot?.dispose(off);
