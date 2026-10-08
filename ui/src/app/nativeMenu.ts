import { inTauri } from '../api/transport';
import { runAction } from './actions';

/** Must match `MENU_EVENT` in `crates/gitbolt-app/src/menu.rs`. */
export const MENU_EVENT = 'gb:menu';

/**
 * The macOS menu bar's own items (Settings…, Quit, Keyboard Shortcuts, …; `menu.rs`) send the id
 * of the app action they stand for, which runs the way its shortcut or the palette runs it. Only
 * in the app: the browser harness has no menu bar. Returns the removal.
 */
export function installNativeMenu(): () => void {
  if (!inTauri()) return () => {};
  let off: (() => void) | undefined;
  let dead = false;
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<string>(MENU_EVENT, (e) => {
      if (!runAction(e.payload)) console.warn(`[gitbolt] menu item ${e.payload}: no such action, or not usable now`);
    }))
    .then((unlisten) => { if (dead) unlisten(); else off = unlisten; })
    .catch((e: unknown) => console.warn('[gitbolt] menu bar events unavailable', e));
  return () => { dead = true; off?.(); };
}
