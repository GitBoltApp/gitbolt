import { ListFilter, PanelLeft } from 'lucide-react';
import type { Profile } from '../api/gen/Profile';
import { activeTab, registerActions } from '../app/actions';
import { registerTabSlot } from '../app/slots';
import { useAppState } from '../app/state';
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

const offActions = registerActions([
  {
    id: 'edit.filterSidebar', label: 'Filter sidebar', group: 'Edit', icon: ListFilter, tooltip: 'Focus the sidebar filter', shortcuts: ['Ctrl+Alt+F'],
    when: () => !!repoTab(),
    run: () => {
      const t = activeTab()!;
      update((p) => ({ ...p, sidebarNarrow: false }));
      requestAnimationFrame(() => focusSidebarFilter(t.id));
    },
  },
  {
    id: 'view.toggleSidebar', label: 'Toggle sidebar', group: 'View', icon: PanelLeft, tooltip: 'Switch the sidebar between full and icon strip', shortcuts: ['Ctrl+B'],
    when: () => !!repoTab(),
    run: () => update((p) => ({ ...p, sidebarNarrow: !p.sidebarNarrow })),
  },
]);
const offSlot = registerTabSlot('sidebar', 'sidebar', Sidebar);

const off = () => { offActions(); offSlot(); };
import.meta.hot?.dispose(off);
