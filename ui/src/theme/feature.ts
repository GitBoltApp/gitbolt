import { Palette } from 'lucide-react';
import { registerActions, type Action } from '../app/actions';
import { useAppState } from '../app/state';
import { useSettingsUi } from '../settings/schema';
import { THEME_IDS, THEMES } from './themes';

/**
 * The theme actions (ruling R4; its own feature module, imported from `app/features.ts`): View →
 * "Theme…" opens Settings on the theme picker, and one palette-only "Theme: <Name>" per theme
 * (`menu: false`), so Ctrl+P `>Theme: Nord` switches in one go.
 */
const offActions = registerActions([
  { id: 'view.theme', label: 'Theme…', group: 'View', icon: Palette, tooltip: 'Choose the colour theme', run: () => useSettingsUi.getState().show('theme') },
  ...THEME_IDS.map((id): Action => ({
    id: `view.theme.${id}`, label: `Theme: ${THEMES[id].label}`, group: 'View', icon: Palette, tooltip: `Switch to the ${THEMES[id].label} theme`, menu: false,
    run: () => useAppState.getState().setSettings({ theme: id }),
  })),
]);
// A dev-server hot update re-runs this module: release the old registrations first.
import.meta.hot?.dispose(offActions);
