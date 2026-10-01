import { ICONS } from '../menu/icons';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import type { HideableColumn } from './columns';

/** The `column` menu's target: the repo's hidden columns and how to toggle one. */
export interface ColumnTarget { hidden: ReadonlySet<HideableColumn>; toggle(col: HideableColumn): void }

/** The hideable columns, in table order, by the name the menu shows. */
export const COLUMN_NAMES: ReadonlyArray<readonly [HideableColumn, string]> = [['labels', 'Branch / Tag'], ['author', 'Author'], ['date', 'Commit date / time'], ['sha', 'SHA']];

// Spec §8.4: every column except Graph and Message can be hidden (per repo). Right-click the
// graph table's header.
registerMenu<ColumnTarget, object>({
  id: 'column.visibility',
  kind: 'column',
  group: 'columns',
  order: 0,
  rows: (t) => COLUMN_NAMES.map(([col, name]): MenuRow => {
    const hidden = t.hidden.has(col);
    return {
      kind: 'action',
      id: `column.${col}`,
      label: `${hidden ? 'Show' : 'Hide'} ${name}`,
      icon: hidden ? ICONS.show : ICONS.hide,
      tooltip: `${hidden ? 'Show' : 'Hide'} the ${name} column for this repository`,
      run: () => t.toggle(col),
    };
  }),
});
