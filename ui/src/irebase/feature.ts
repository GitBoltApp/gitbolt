import { ListOrdered } from 'lucide-react';
import { lazy } from 'react';
import { activeTab, registerActions } from '../app/actions';
import { useRuntime } from '../app/runtime';
import { registerMenu } from '../menu/registry';
import type { CommitTarget, MenuEnv, SelectionTarget } from '../menu/menuEnv';
import { registerCenterView } from '../repo/centerView';
import { chipCopyRows, chipManageRows, type ChipTarget } from './chipMenu';
import { fromHereRows, ontoRows, paletteRebase, paletteUsable, selectionFromHereRows, squashRows } from './menus';
import { REBASE_VIEW } from './open';
import { pruneSessions } from './session';
import { registerKeyHints } from '../shortcuts/hints';

/** The interactive rebase (spec #3 §4.1, §4.3): the editor (a center view, loaded on first open),
 * its menu rows and the palette's entry. */
const offs = [
  // A closed tab's session goes with it (its center view already does: runtime's drop).
  useRuntime.subscribe((s) => pruneSessions((id) => id in s.tabs)),
  // It takes the sidebar's place too, and a row it selects shows in the details panel (UX R2.1, R2.2).
  registerCenterView(REBASE_VIEW, lazy(() => import('./RebaseEditor').then((m) => ({ default: m.RebaseEditor }))), { sidebar: 'hide', drivesSelection: true }),
  registerMenu<CommitTarget, MenuEnv>({ id: 'commit.irebase.onto', kind: 'commit', group: 'integrate', order: 1, rows: ontoRows }),
  registerMenu<CommitTarget, MenuEnv>({ id: 'commit.irebase.fromHere', kind: 'commit', group: 'commit', order: 30, rows: fromHereRows }),
  registerMenu<SelectionTarget, MenuEnv>({ id: 'selection.irebase.squash', kind: 'selection', group: 'squash', order: 0, rows: squashRows }),
  registerMenu<SelectionTarget, MenuEnv>({ id: 'selection.irebase.fromHere', kind: 'selection', group: 'rebase', order: 0, rows: selectionFromHereRows }),
  registerMenu<ChipTarget, object>({ id: 'chip.irebase.manage', kind: 'chip', group: 'manage', order: 0, rows: chipManageRows }),
  registerMenu<ChipTarget, object>({ id: 'chip.irebase.copy', kind: 'chip', group: 'copy', order: 0, rows: chipCopyRows }),
  registerActions([{
    id: 'repo.interactiveRebase', label: 'Interactive rebase…', group: 'Repository', icon: ListOrdered,
    tooltip: "Reorder, reword, squash or drop the current branch's commits on its upstream",
    when: () => { const t = activeTab(); return !!t && paletteUsable(t.id); },
    run: () => { const t = activeTab(); if (t) paletteRebase(t.id); },
  }]),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.rb.action', section: 'Rebase editor', label: 'Pick / Reword / Squash / Fixup / Drop / Edit', keys: ['P', 'R', 'S', 'F', 'D', 'E'], context: '(when a row is selected)', source: 'irebase/RebaseEditor.tsx' },
  { id: 'key.rb.move', section: 'Rebase editor', label: 'Move row', keys: ['Ctrl+Up', 'Ctrl+Down'], source: 'irebase/RebaseEditor.tsx' },
  { id: 'key.rb.msg', section: 'Rebase editor', label: 'Edit message', keys: ['Enter'], context: '(when a row is selected)', source: 'irebase/RebaseEditor.tsx' },
  { id: 'key.rb.save', section: 'Rebase editor', label: 'Save the plan', keys: ['Ctrl+Enter'], source: 'irebase/RebaseEditor.tsx' },
  { id: 'key.rb.cancel', section: 'Rebase editor', label: 'Cancel', keys: ['Esc'], source: 'irebase/RebaseEditor.tsx' },
]);
