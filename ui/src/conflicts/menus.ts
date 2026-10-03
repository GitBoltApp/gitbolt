import { ArrowLeftToLine, ArrowRightToLine, CheckCheck } from 'lucide-react';
import { activeTab } from '../app/actions';
import { tabStore } from '../app/tabStores';
import type { FileTarget, MenuEnv } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { journalKey, useJournal } from '../undo/store';
import { COMMIT_QUEUED, stagingKey, useStaging } from '../stage/store';
import { useToast } from '../ui/toast';
import type { WriteCtx } from '../write/client';
import { writeCtx } from '../write/ctx';
import { isMergeDirty, MERGE_SAVE_FIRST } from './mergeDrafts';
import { markResolved, resolveFile } from './resolve';
import { sidesIn } from './sides';

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
    // UX round 2: the sides by name, as the merge tool's pane titles ("main (current)").
    const graph = tab ? tabStore(tab.id)?.getState().graph : undefined;
    const target = ctx ? useJournal.getState().states[journalKey(ctx.repoId, ctx.worktree)]?.paused?.target ?? null : null;
    const sides = graph ? sidesIn(graph, root, target) : { current: null, incoming: null };
    const side = (s: 'current' | 'incoming') => (sides[s] ? `${sides[s]} (${s})` : `the ${s} side`);
    const run = (f: (c: WriteCtx) => Promise<unknown>) => () => {
      const at = activeTab();
      const c = at ? writeCtx(at.id, root) : null;
      if (c && isMergeDirty(c.tabId, c.worktree, t.path)) useToast.getState().show(`${MERGE_SAVE_FIRST}: ${t.path} has unsaved merge-tool edits`, { error: true });
      else if (c) void f(c);
      else useToast.getState().show(`Couldn't resolve ${t.path}: its repository's tab isn't open`, { error: true });
    };
    return [
      row({ id: 'file.takeCurrent', label: 'Take current', icon: ArrowLeftToLine, tooltip: `Resolve ${t.path} with the version in ${side('current')}`, run: run((c) => resolveFile(c, t.path, { kind: 'current' })), disabledReason: queued }),
      row({ id: 'file.takeIncoming', label: 'Take incoming', icon: ArrowRightToLine, tooltip: `Resolve ${t.path} with the version in ${side('incoming')}`, run: run((c) => resolveFile(c, t.path, { kind: 'incoming' })), disabledReason: queued }),
      row({ id: 'file.markResolved', label: 'Mark resolved', icon: CheckCheck, tooltip: `Mark ${t.path} resolved as it is now`, run: run((c) => markResolved(c, t.path)), disabledReason: queued }),
    ];
  },
});
import.meta.hot?.dispose(off);
