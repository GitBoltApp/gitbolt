import { History, RotateCcw, Trash2, User } from 'lucide-react';
import { activeTab } from '../app/actions';
import { shortSha } from '../format/sha';
import type { FileTarget, MenuEnv } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { openFileHistory } from './open';
import { restoreFile } from './restore';
import { historyStart, restoreSource } from './sources';

const row = (r: Omit<Extract<MenuRow, { kind: 'action' }>, 'kind'>): MenuRow => ({ kind: 'action', ...r });

/** "File history" and "Blame" (spec #3 §4.2) on every file row that has a history. */
const offHistory = registerMenu<FileTarget, MenuEnv>({
  id: 'file.history', kind: 'file', group: 'history', order: 0,
  rows: (t) => {
    const start = historyStart(t);
    const tab = activeTab();
    if (!start || !tab) return [];
    return [
      row({ id: 'file.fileHistory', label: 'File history', icon: History, tooltip: `Show the commits that changed ${start.path}`, run: () => void openFileHistory(tab.id, start, false) }),
      row({ id: 'file.blame', label: 'Blame', icon: User, tooltip: `Show who last changed each line of ${start.path}`, run: () => void openFileHistory(tab.id, start, true) }),
    ];
  },
});

/** Restore file from a commit (spec #3 §3.8): into the active worktree, unstaged, undoable. Hidden
 * with no write target and mid-operation (the write refuses then). Over the file's own changes,
 * the clicked row arms in place (`restoreFile` → `runWrite`). */
const offRestore = registerMenu<FileTarget, MenuEnv>({
  id: 'file.restore', kind: 'file', group: 'restore', order: 0,
  when: (_t, env) => env.write !== null && env.inProgress === null,
  rows: (t, env) => {
    const src = restoreSource(t);
    if (!src || !env.write) return [];
    const ctx = env.write;
    const sha = shortSha(src.sha);
    const run = () => void restoreFile(ctx, src.sha, t.path, src.absent);
    return [src.absent
      ? row({ id: 'file.restore', label: `Delete ${t.path}`, icon: Trash2, tooltip: `${t.path} isn't in ${sha}: delete it from the working tree (you can undo this)`, run })
      : row({ id: 'file.restore', label: `Restore from ${sha}`, icon: RotateCcw, tooltip: `Write ${t.path} as it is in ${sha} into the working tree, unstaged (you can undo this)`, run })];
  },
});

import.meta.hot?.dispose(() => { offHistory(); offRestore(); });
