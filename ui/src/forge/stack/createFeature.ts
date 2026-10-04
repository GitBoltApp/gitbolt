import { registerSyncRows } from '../../sync/menus';
import { createStackRow } from './create';
import { offCreateStackDialog, openCreateStack } from './CreateStackDialog';
import { branchMr, forgeTarget } from './deps';

/** Create stack MRs/PRs (spec #4 §4 4D): the dialog, and its row in a stack member chip's Sync group (after Push stack, order 20). */
const offs = [
  offCreateStackDialog,
  registerSyncRows(30, (t, env) => {
    const tabId = env.write?.tabId;
    if (!tabId) return [];
    return createStackRow(t, env, forgeTarget(tabId), (b) => branchMr(tabId, b), (s) => openCreateStack(tabId, s));
  }),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
