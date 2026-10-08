import { Keyboard } from 'lucide-react';
import { registerActions } from '../app/actions';
import { registerAppSlot } from '../app/slots';
import './viewHints';
import { ShortcutsPanel, useShortcutsUi } from './ShortcutsPanel';

/** Help → Keyboard shortcuts (Ctrl+/) and its panel. */
const offs = [
  registerActions([
    { id: 'help.shortcuts', label: 'Keyboard shortcuts', group: 'Help', icon: Keyboard, tooltip: 'Every keyboard shortcut, filterable', shortcuts: ['Mod+/'], run: () => useShortcutsUi.getState().setOpen(true) },
  ]),
  registerAppSlot('overlay', 'shortcuts.panel', ShortcutsPanel),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
