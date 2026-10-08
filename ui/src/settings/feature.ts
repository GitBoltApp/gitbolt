import { Settings } from 'lucide-react';
import { registerActions } from '../app/actions';
import { registerAppSlot } from '../app/slots';
import { SettingsView } from './SettingsView';
import { useSettingsUi } from './schema';

/**
 * Settings' registrations (ruling R10: its own module, imported from `app/features.ts`): the
 * `file.settings` action (Ctrl+, and the hamburger's File menu) and the dialog in the overlay
 * slot. The palette's `#` group opens it on one setting with `useSettingsUi.show(id)`.
 */
const offActions = registerActions([
  {
    id: 'file.settings', label: 'Settings', group: 'File', icon: Settings, tooltip: 'App, profile and repository settings', shortcuts: ['Mod+,'],
    run: () => useSettingsUi.getState().show(),
  },
]);
const offSlot = registerAppSlot('overlay', 'settings.dialog', SettingsView);
// A dev-server hot update re-runs this module: release the old registrations first.
import.meta.hot?.dispose(() => {
  offActions();
  offSlot();
});
