import { Command } from 'lucide-react';
import { registerActions } from '../app/actions';
import { registerAppSlot } from '../app/slots';
import { registerToolbarButton } from '../toolbar/registry';
import { Palette, usePalette } from './Palette';

/**
 * The palette's registrations (ruling R10: its own module, imported from `app/features.ts`): the
 * `edit.palette` action (Ctrl+P), the dialog in the overlay slot, and the toolbar's Actions
 * button (the toolbar renders buttons from the registry, so it needs no edit).
 */
const offs = [
  registerActions([
    { id: 'edit.palette', label: 'Command palette', group: 'Edit', icon: Command, tooltip: 'Search actions, branches, files, settings and tabs', shortcuts: ['Mod+P'], run: () => usePalette.getState().show() },
  ]),
  registerAppSlot('overlay', 'palette.dialog', Palette),
  registerToolbarButton({ action: 'edit.palette', label: 'Actions', placement: 'end', order: 10 }),
];
// A dev-server hot update re-runs this module: release the old registrations first.
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
