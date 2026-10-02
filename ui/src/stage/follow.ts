import type { FileListPayload } from '../api/gen/FileListPayload';
import { tabView } from '../app/tabStores';
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

/** Re-targets the tab's open diff after a write in `worktree`. */
export function followOpenFile(tabId: string, worktree: string): void {
  const view = tabView(tabId);
  const store = view?.store;
  const open = store?.getState().diff;
  if (!view || !store || !open) return;
  const wip = view.services.wip;
  const next = followTarget(open, worktree, { staged: wip.peek(wipKey(worktree, true)), unstaged: wip.peek(wipKey(worktree, false)) });
  if (next === open) return;
  if (next === null) store.getState().closeDiffTo('files');
  else store.getState().openFile(next);
}
