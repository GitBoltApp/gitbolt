import { ArrowLeftToLine, ArrowRightToLine, CheckCheck } from 'lucide-react';
import { activeTab } from '../app/actions';
import type { FileTarget, MenuEnv } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { COMMIT_QUEUED, stagingKey, useStaging } from '../stage/store';
import { ERROR_TOAST_MS, useToast } from '../ui/toast';
import type { WriteCtx } from '../write/client';
import { writeCtx } from '../write/ctx';
import { isMergeDirty, MERGE_SAVE_FIRST } from './mergeDrafts';
import { markResolved, resolveFile } from './resolve';

const row = (r: Omit<Extract<MenuRow, { kind: 'action' }>, 'kind'>): MenuRow => ({ kind: 'action', ...r });

/** §7.1: on a conflicted WIP file, Take current / Take incoming / Mark resolved. The rows come
 * from the target alone (the menu stays synchronous); the write context is read on the click. */
const off = registerMenu<FileTarget, MenuEnv>({
  id: 'file.conflict', kind: 'file', group: 'conflict', order: 0,
  rows: (t): MenuRow[] => {
    if (t.list !== 'wip' || t.diff.status !== 'U') return [];
    const root = t.wip?.worktree ?? t.root;
    const tab = activeTab();
    const ctx = tab ? writeCtx(tab.id, root) : null;
    // 2D T20: the merge tool's unsaved work on this file would be replaced; save it first.
    const queued = ctx && useStaging.getState().committing[stagingKey(ctx.repoId, ctx.worktree)] ? COMMIT_QUEUED
      : ctx && isMergeDirty(ctx.tabId, ctx.worktree, t.path) ? MERGE_SAVE_FIRST : undefined;
    const run = (f: (c: WriteCtx) => Promise<unknown>) => () => {
      const at = activeTab();
      const c = at ? writeCtx(at.id, root) : null;
      if (c && isMergeDirty(c.tabId, c.worktree, t.path)) useToast.getState().show(`${MERGE_SAVE_FIRST}: ${t.path} has unsaved merge-tool edits`, { ms: ERROR_TOAST_MS });
      else if (c) void f(c);
      else useToast.getState().show(`Couldn't resolve ${t.path}: its repository's tab isn't open`, { ms: ERROR_TOAST_MS });
    };
    return [
      row({ id: 'file.takeCurrent', label: 'Take current', icon: ArrowLeftToLine, tooltip: `Resolve ${t.path} with the current side's version`, run: run((c) => resolveFile(c, t.path, { kind: 'current' })), disabledReason: queued }),
      row({ id: 'file.takeIncoming', label: 'Take incoming', icon: ArrowRightToLine, tooltip: `Resolve ${t.path} with the incoming side's version`, run: run((c) => resolveFile(c, t.path, { kind: 'incoming' })), disabledReason: queued }),
      row({ id: 'file.markResolved', label: 'Mark resolved', icon: CheckCheck, tooltip: `Mark ${t.path} resolved as it is now`, run: run((c) => markResolved(c, t.path)), disabledReason: queued }),
    ];
  },
});
import.meta.hot?.dispose(off);
