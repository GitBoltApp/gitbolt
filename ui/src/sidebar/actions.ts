import { ListFilter, PanelLeft } from 'lucide-react';
import type { Profile } from '../api/gen/Profile';
import { activeTab, registerActions } from '../app/actions';
import { registerTabSlot } from '../app/slots';
import { useAppState } from '../app/state';
import { leaveFileView, sidebarHidden } from '../repo/centerView';
import { Sidebar } from './Sidebar';
import { focusSidebarFilter } from './sidebarNav';

/** This feature's own module (ruling R10 / ping P23): the sidebar's actions and its tab slot,
 * registered here instead of in the shared `coreActions.ts`/`slots.tsx`, so no two features ever
 * edit the same file. `app/features.ts` imports this once. */
const update = (fn: (p: Profile) => Profile) => useAppState.getState().updateProfile(fn);
const repoTab = () => {
  const t = activeTab();
  return t?.kind === 'repo' && t.path ? t : null;
};
/** A repo tab whose sidebar is there: under the rebase editor it's hidden (UX R2.1), and its
 * actions stand aside rather than flip the stored setting unseen. */
const sidebarTab = () => {
  const t = repoTab();
  return t && !sidebarHidden(t.id) ? t : null;
};

const offActions = registerActions([
  {
    id: 'edit.filterSidebar', label: 'Filter sidebar', group: 'Edit', icon: ListFilter, tooltip: 'Focus the sidebar filter', shortcuts: ['Mod+Alt+F'],
    when: () => !!sidebarTab(),
    run: () => {
      const t = activeTab()!;
      leaveFileView(t.id);
      update((p) => ({ ...p, sidebarNarrow: false }));
      requestAnimationFrame(() => focusSidebarFilter(t.id));
    },
  },
  {
    id: 'view.toggleSidebar', label: 'Toggle sidebar', group: 'View', icon: PanelLeft, tooltip: 'Switch the sidebar between full and icon strip', shortcuts: ['Mod+B'],
    when: () => !!sidebarTab(),
    // Over a file view, it's the strip's (>): leave the view, expanded (UX R2.3).
    run: () => {
      const t = repoTab();
      if (t && leaveFileView(t.id)) update((p) => ({ ...p, sidebarNarrow: false }));
      else update((p) => ({ ...p, sidebarNarrow: !p.sidebarNarrow }));
    },
  },
]);
const offSlot = registerTabSlot('sidebar', 'sidebar', Sidebar);

const off = () => { offActions(); offSlot(); };
import.meta.hot?.dispose(off);
