// ui/src/stacks/feature.ts
import { offStackMenus } from './menus';

/** Stacks (spec #3 §3.11): the branch chip menu's Push stack and Rebase stack rows. */
const offs = [...offStackMenus];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
