import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileListPayload } from '../api/gen/FileListPayload';
import { tabView } from '../app/tabStores';
import { splitConflicted } from '../details/conflicted';
import { useFileListPrefs } from '../files/fileListPrefs';
import { displayTargets } from '../files/fileTree';
import { targetFor, type DiffTarget } from '../repo/store';
import { wipKey } from '../repo/wipLists';

/**
 * Spec #2 §7.1 "The open diff follows the file", after a write's fresh lists are in:
 * - a file still in the section it was opened from stays there, with its fresh sides (a partial stage);
 * - one that left it (a whole file staged or unstaged) reopens from the other section;
 * - one in neither (discarded) closes: `null`.
 *
 * A diff that isn't this worktree's WIP is returned unchanged.
 */
export function followTarget(open: DiffTarget, worktree: string, lists: { staged?: FileListPayload; unstaged?: FileListPayload }): DiffTarget | null {
  const fromStaged = open.key.startsWith(`${wipKey(worktree, true)}|`);
  if (!fromStaged && !open.key.startsWith(`${wipKey(worktree, false)}|`)) return open;
  const find = (staged: boolean): DiffTarget | null => {
    const f = (staged ? lists.staged : lists.unstaged)?.files.find((x) => x.path === open.path);
    return f ? { ...targetFor(f, { kind: 'wip', worktree, staged }), view: open.view } : null;
  };
  return find(fromStaged) ?? find(!fromStaged);
}

/** The open diff's place in its WIP section before a whole-file write: the paths the section
 * lists, in the order it displays them (its Path/Tree mode and sort), and which section. */
export interface AdvanceFrom { staged: boolean; path: string; order: string[] }

const EMPTY = { files: [], added: 0, deleted: 0 } as unknown as FileListPayload;
const sections = (staged?: FileListPayload, unstaged?: FileListPayload) => splitConflicted(unstaged ?? EMPTY, staged ?? EMPTY);

/** Taken before a whole-file write. `null`: the setting is off, or no diff of this worktree's
 * staged or unstaged files is open. */
export function advanceFrom(tabId: string, worktree: string): AdvanceFrom | null {
  if (!useFileListPrefs.getState().advanceAfterStage) return null;
  const view = tabView(tabId);
  const open = view?.store.getState().diff;
  if (!view || !open) return null;
  const staged = open.key.startsWith(`${wipKey(worktree, true)}|`);
  if (!staged && !open.key.startsWith(`${wipKey(worktree, false)}|`)) return null;
  const { staged: s, unstaged: u } = sections(view.services.wip.peek(wipKey(worktree, true)), view.services.wip.peek(wipKey(worktree, false)));
  const { mode, sort } = useFileListPrefs.getState();
  const spec: DiffSpec = { kind: 'wip', worktree, staged };
  const order = displayTargets((staged ? s : u).files, spec, mode, sort).map((t) => t.path);
  return order.includes(open.path) ? { staged, path: open.path, order } : null;
}

/**
 * Where the view goes after a whole-file write took the open file out of its section: the file now
 * at its place (the first below it in the old order that the section still lists), else the one
 * above. With the section empty: a stage or unstage shows the file where it went (`undefined`, the
 * caller follows it); a discard, which left it nowhere, takes the other section's first file in
 * display order, or `null` (nothing to show). `undefined` also when the file is still in its
 * section (a partial write).
 */
export function advanceTarget(from: AdvanceFrom, worktree: string, lists: { staged?: FileListPayload; unstaged?: FileListPayload }, view: DiffTarget['view']): DiffTarget | null | undefined {
  const now = sections(lists.staged, lists.unstaged);
  const mine = from.staged ? now.staged : now.unstaged;
  if (mine.files.some((f) => f.path === from.path)) return undefined;
  const pick = (staged: boolean, path: string): DiffTarget | null => {
    const f = (staged ? now.staged : now.unstaged).files.find((x) => x.path === path);
    return f ? { ...targetFor(f, { kind: 'wip', worktree, staged }), view } : null;
  };
  const listed = new Set(mine.files.map((f) => f.path));
  const at = from.order.indexOf(from.path);
  const path = from.order.slice(at + 1).find((p) => listed.has(p)) ?? from.order.slice(0, at).reverse().find((p) => listed.has(p));
  if (path !== undefined) return pick(from.staged, path);
  const otherList = from.staged ? now.unstaged : now.staged;
  if (otherList.files.some((f) => f.path === from.path)) return undefined; // it moved across: follow it
  const { mode, sort } = useFileListPrefs.getState();
  const other = displayTargets(otherList.files, { kind: 'wip', worktree, staged: !from.staged }, mode, sort)[0];
  return other ? { ...other, view } : null;
}

/** Re-targets the tab's open diff after a write in `worktree`; `from`: a whole-file write's
 * `advanceFrom`, taken before it. */
export function followOpenFile(tabId: string, worktree: string, from: AdvanceFrom | null = null): void {
  const view = tabView(tabId);
  const store = view?.store;
  const open = store?.getState().diff;
  if (!view || !store || !open) return;
  const wip = view.services.wip;
  const lists = { staged: wip.peek(wipKey(worktree, true)), unstaged: wip.peek(wipKey(worktree, false)) };
  // The open file is the one `from` was taken for (the diff may have moved while the write ran).
  const adv = from && from.path === open.path ? advanceTarget(from, worktree, lists, open.view) : undefined;
  if (adv !== undefined) {
    if (adv === null) store.getState().closeDiffTo('files');
    else store.getState().openFile(adv);
    return;
  }
  const next = followTarget(open, worktree, lists);
  if (next === open) return;
  if (next === null) store.getState().closeDiffTo('files');
  else store.getState().openFile(next);
}
