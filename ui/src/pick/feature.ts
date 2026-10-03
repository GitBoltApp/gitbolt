import { offPickMenus } from './menus';

/** Cherry-pick and revert (spec #3 §3.7, §4.3): the Commit group of the commit menu and of the
 * selection's menu. A stop shows in the commit panel (2D's PickControl) and the merge tool. */
const offs = [...offPickMenus];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
