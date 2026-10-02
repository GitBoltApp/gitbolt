import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';

type Rows = (t: CommitTarget, env: MenuEnv) => MenuRow[];
const builders: Array<{ order: number; rows: Rows }> = [];

/** Adds rows to the commit/branch menu's Sync group (core §7), lower `order` first: Pull (T19,
 * order 0), then Push (T17, order 10). 2C's Set upstream row is its own registration in the
 * same group. Returns its removal. */
export function registerSyncRows(order: number, rows: Rows): () => void {
  const b = { order, rows };
  builders.push(b);
  builders.sort((x, y) => x.order - y.order);
  return () => void builders.splice(builders.indexOf(b), 1);
}

export const offSyncMenu = registerMenu<CommitTarget, MenuEnv>({
  id: 'commit.sync', kind: 'commit', group: 'sync', order: 0,
  rows: (t, env) => builders.flatMap((b) => b.rows(t, env)),
});
