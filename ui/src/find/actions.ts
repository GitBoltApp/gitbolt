import { Search } from 'lucide-react';
import { activeStore, activeTab, registerActions } from '../app/actions';
import { registerTabSlot } from '../app/slots';
import { loadMonacoHost } from '../diff/monaco/load';
import { FindBox } from './FindBox';
import { openFind } from './findStore';

/**
 * Find's registrations (ruling R10: its own module, imported from `app/features.ts`): the
 * `edit.find` action (Ctrl+F, the hamburger's Edit menu, the toolbar's Search button) and the
 * FindBox in the graph panel's overlay slot.
 *
 * Ctrl+F (ruling R7): while a file is open (the graph is hidden under it, spec §10.1) it opens
 * Monaco's own find in that file's editor; otherwise the graph's find box (J5).
 */
const offActions = registerActions([
  {
    id: 'edit.find', label: 'Find in graph', group: 'Edit', icon: Search, tooltip: 'Find commits by message, SHA or path', shortcuts: ['Ctrl+F'],
    // A repo tab showing a graph (an unborn repo's "No commits yet" has none to search).
    when: () => (activeStore()?.getState().graph.rows.length ?? 0) > 0,
    run: () => {
      const t = activeTab();
      const store = activeStore();
      if (!t || !store) return;
      if (store.getState().diff) void loadMonacoHost().then((host) => host.openFind());
      else openFind(t.id);
    },
  },
]);
const offSlot = registerTabSlot('graphOverlay', 'find.box', FindBox);
// A dev-server hot update re-runs this module: release the old registrations first.
import.meta.hot?.dispose(() => {
  offActions();
  offSlot();
});
