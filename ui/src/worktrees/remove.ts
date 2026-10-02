import { api } from '../api/client';
import { useAppState } from '../app/state';
import { useRuntime } from '../app/runtime';
import { confirmAction } from '../ui/ConfirmDialog';
import { runWrite, type WriteCtx } from '../write/client';
import { closeTab, tabWorktree } from '../app/tabs';
import { mainWorktreeOf, setActiveWorktree } from './active';
import { worktreeDisplay } from './paths';

/** Remove (§11.1): always confirmed (it isn't undoable); a dirty worktree asks once more before
 * `--force`. Every tab whose active worktree it is moves to the main worktree first. */
export async function removeWorktree(ctx: WriteCtx, path: string, branch: string | null): Promise<void> {
  const main = mainWorktreeOf(ctx.tabId) ?? ctx.worktree;
  const shown = worktreeDisplay(main, path);
  const stays = branch ? `branch ${branch.replace(/^refs\/heads\//, '')} stays` : 'its commits stay';
  if (!(await confirmAction({ title: 'Remove worktree?', body: `Remove worktree ${shown}? Its folder is deleted; ${stays}.`, confirmLabel: 'Remove', danger: true }))) return;
  const at = { ...ctx, worktree: main };
  const onIt = () => useAppState.getState().profile.tabs.filter((t) => t.kind === 'repo' && useRuntime.getState().tabs[t.id]?.repo?.id === ctx.repoId && useRuntime.getState().tabs[t.id]?.worktree === path).map((t) => t.id);
  // A tab on the removed worktree moves to main first (§11.1). Where another tab already shows
  // main, that tab is a twin: the removed one is closed after the removal instead.
  let moved: string[] = [];
  let closing: string[] = [];
  const moveAway = () => {
    for (const id of onIt()) {
      const tabs = useAppState.getState().profile.tabs;
      const me = tabs.find((x) => x.id === id);
      const twin = tabs.some((t) => t.id !== id && t.kind === 'repo' && t.path === me?.path && tabWorktree(t) === main);
      if (twin) closing.push(id);
      else { setActiveWorktree(id, main); moved.push(id); }
    }
  };
  const putBack = () => { for (const id of moved) setActiveWorktree(id, path); moved = []; closing = []; };
  const send = (force: boolean) => { moveAway(); return runWrite(at, () => api.worktreeRemove(ctx.repoId, main, path, force)); };
  const done = () => { for (const id of closing) { const app = useAppState.getState(); app.setProfile(closeTab(app.profile, id)); } };
  const out = await send(false);
  if (out === null) { putBack(); return; }
  if (out.status !== 'needsForce') { done(); return; }
  putBack();
  const again = await confirmAction({ title: 'Remove it anyway?', body: `${shown} has changes that aren't committed. Remove it anyway? They're lost: this can't be undone.`, confirmLabel: 'Remove', danger: true });
  if (!again) return;
  const forced = await send(true);
  if (forced === null) putBack(); else done();
}
