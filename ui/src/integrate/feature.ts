import { offIntegrateMenu } from './menus';

/** Integrate (spec #2 §13): the Integrate rows of the branch-label menu. The rebase counter and
 * chip render from the status bar and the graph. */
const offs = [offIntegrateMenu];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
