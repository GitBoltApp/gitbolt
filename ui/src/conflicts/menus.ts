import { ArrowLeftToLine, ArrowRightToLine, CheckCheck } from 'lucide-react';
import { activeTab } from '../app/actions';
import { tabStore } from '../app/tabStores';
import type { FileTarget, FolderTarget, MenuEnv } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { journalKey, useJournal } from '../undo/store';
import { COMMIT_QUEUED, stagingKey, useStaging } from '../stage/store';
import { useToast } from '../ui/toastStore';
import type { WriteCtx } from '../write/client';
import { writeCtx } from '../write/ctx';
import { isMergeDirty, MERGE_SAVE_FIRST } from './mergeDrafts';
import { markAllResolved, markResolved, resolveFile } from './resolve';
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

/** A folder in Conflicted (tree mode): Mark its conflicted files resolved, each as it is, in one
 * write. Files that still have markers make the row arm in place first (`markersRemainIn`). */
const offFolder = registerMenu<FolderTarget, MenuEnv>({
  id: 'folder.conflict', kind: 'folder', group: 'conflict', order: 0,
  rows: (t): MenuRow[] => {
    const paths = t.wip?.conflicted ?? [];
    if (!t.wip || paths.length === 0) return [];
    const root = t.wip.worktree;
    const tab = activeTab();
    const ctx = tab ? writeCtx(tab.id, root) : null;
    const dirty = (c: WriteCtx) => paths.find((p) => isMergeDirty(c.tabId, c.worktree, p));
    const queued = ctx && useStaging.getState().committing[stagingKey(ctx.repoId, ctx.worktree)] ? COMMIT_QUEUED
      : ctx && dirty(ctx) ? MERGE_SAVE_FIRST : undefined;
    const n = paths.length;
    const files = `${n} ${n === 1 ? 'file' : 'files'}`;
    const run = () => {
      const at = activeTab();
      const c = at ? writeCtx(at.id, root) : null;
      const open = c && dirty(c);
      if (open) useToast.getState().show(`${MERGE_SAVE_FIRST}: ${open} has unsaved merge-tool edits`, { error: true });
      else if (c) void markAllResolved(c, paths);
      else useToast.getState().show(`Couldn't resolve the files in ${t.path}: its repository's tab isn't open`, { error: true });
    };
    return [row({ id: 'folder.markResolved', label: `Mark ${files} resolved`, icon: CheckCheck, tooltip: `Mark the ${files} conflicted in ${t.path}/ resolved as they are now`, run, disabledReason: queued })];
  },
});
import.meta.hot?.dispose(() => {
  off();
  offFolder();
});
