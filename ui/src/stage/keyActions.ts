import { FileMinus, FilePlus, ListMinus, ListPlus, SquareSplitVertical } from 'lucide-react';
import type { FileChange } from '../api/gen/FileChange';
import { activeStore, activeTab, registerActions } from '../app/actions';
import { lentHandler } from '../app/lent';
import { tabView } from '../app/tabStores';
import { splitConflicted } from '../details/conflicted';
import { wipSideOf } from '../diff/wipHunks';
import { wipKey } from '../repo/wipLists';
import type { WriteCtx } from '../write/client';
import { pathsOf, stageAll, stagePaths, unstageAll, unstageFiles } from './actions';

/**
 * Staging from the keyboard: the open file (the file list's cursor opens the file it lands on,
 * so it's the "selected" one), the hunk or lines at the diff's cursor (the open diff lends it,
 * `HunkActions`), and Stage all / Unstage all for the palette. Ctrl chords, so they work from the
 * file list and the diff editor alike; none of them means anything to text.
 */
interface OpenWip { ctx: WriteCtx; staged: boolean; file: Pick<FileChange, 'path' | 'oldPath'> }

/** The open diff, when it's a staged or unstaged WIP file (not a conflicted one: the merge tool
 * marks those resolved, nor "View all files"' unchanged ones). */
export function openWipFile(): OpenWip | null {
  const t = activeTab();
  const s = activeStore()?.getState();
  const d = s?.diff;
  const side = d ? wipSideOf(d) : null;
  if (!t || !s || !d || !side || d.status === 'U' || d.status === '') return null;
  return { ctx: { tabId: t.id, repoId: s.repo, worktree: side.worktree }, staged: side.staged, file: { path: d.path, oldPath: d.oldPath } };
}

/** The WIP panel's lists, Conflicted split off (§7.1). */
function wipLists() {
  const t = activeTab();
  const s = activeStore()?.getState();
  const sel = s?.selection;
  const view = t ? tabView(t.id) : undefined;
  if (!t || !s || sel?.kind !== 'wip' || !view) return null;
  const staged = view.services.wip.peek(wipKey(sel.worktree, true));
  const unstaged = view.services.wip.peek(wipKey(sel.worktree, false));
  if (!staged || !unstaged) return null;
  return { ctx: { tabId: t.id, repoId: s.repo, worktree: sel.worktree }, ...splitConflicted(unstaged, staged) };
}

const off = registerActions([
  {
    id: 'stage.file', label: 'Stage file', group: 'Repository', section: 'Staging', icon: FilePlus, tooltip: 'Stage the open file', shortcuts: ['Ctrl+Shift+S'], menu: false,
    when: () => openWipFile()?.staged === false,
    run: () => { const o = openWipFile(); if (o) void stagePaths(o.ctx, pathsOf([o.file])); },
  },
  // The same chord: the open file is in one list or the other, never both.
  {
    id: 'stage.unstageFile', label: 'Unstage file', group: 'Repository', section: 'Staging', icon: FileMinus, tooltip: 'Move the open file back to Unstaged', shortcuts: ['Ctrl+Shift+S'], menu: false,
    when: () => openWipFile()?.staged === true,
    run: () => { const o = openWipFile(); if (o) void unstageFiles(o.ctx, [o.file as FileChange]); },
  },
  {
    id: 'stage.hunk', group: 'Repository', section: 'Staging', icon: SquareSplitVertical, shortcuts: ['Ctrl+Shift+D'], menu: false,
    get label() { return `${openWipFile()?.staged ? 'Unstage' : 'Stage'} the hunk or lines at the cursor`; },
    get tooltip() { return 'The lines selected in the diff, else the hunk the cursor is in (F7 moves it to the next change)'; },
    when: () => lentHandler('stage.hunk') !== null,
    run: () => lentHandler('stage.hunk')?.(),
  },
  {
    id: 'stage.all', label: 'Stage all changes', group: 'Repository', section: 'Staging', icon: ListPlus, tooltip: 'Stage every unstaged change', menu: false,
    when: () => (wipLists()?.unstaged.files.length ?? 0) > 0,
    // While files are conflicted, only the other paths: `git add -A` would mark them resolved.
    run: () => {
      const l = wipLists();
      if (l) void (l.conflicted.files.length ? stagePaths(l.ctx, pathsOf(l.unstaged.files)) : stageAll(l.ctx));
    },
  },
  {
    id: 'stage.unstageAll', label: 'Unstage all changes', group: 'Repository', section: 'Staging', icon: ListMinus, tooltip: 'Move every staged change back to Unstaged', menu: false,
    when: () => (wipLists()?.staged.files.length ?? 0) > 0,
    run: () => { const l = wipLists(); if (l) void unstageAll(l.ctx); },
  },
]);
import.meta.hot?.dispose(off);
