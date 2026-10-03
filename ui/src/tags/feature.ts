import { offTagMenus } from './menus';

/** Tags (spec #3 §3.9): Create tag here in the commit menu's Commit group, a tag's Push and
 * Delete, and a remote's "Push all tags". The follow-tags setting lives in Settings ▸ Fetch. */
const offs = [...offTagMenus];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
