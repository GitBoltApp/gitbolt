import { api } from '../api/client';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import { flushSaves, useAppState } from '../app/state';
import { useRuntime } from '../app/runtime';
import { notifyForgeAccountsChanged } from '../forge/accountsBus';
import { currentOrigin } from '../ui/arm/origin';
import { confirmAction } from '../ui/ConfirmDialog';
import { runWrite, type WriteCtx } from '../write/client';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "a, b, c and 2 more": up to three names, then how many others. */
export function namesUpTo3(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown.join('');
}

/** What removing `name` does, from the sidebar: its remote branches, the local branches tracking
 * it (they lose their upstream), and the main remote choice when it's this one (`main`). */
export function removeRemoteText(name: string, sidebar: SidebarPayload | null, main = false): { title: string; body: string; arm: string } {
  const remotes = sidebar?.remotes.map((g) => g.name) ?? [name];
  const branches = sidebar?.remotes.find((g) => g.name === name)?.branches.length ?? 0;
  // The longest remote name the upstream starts with (`up/stream` before `up`), as the menus read it.
  const remoteOf = (ref: string) => [...remotes].sort((a, b) => b.length - a.length).find((r) => ref.startsWith(`refs/remotes/${r}/`));
  const tracking = (sidebar?.locals ?? []).filter((l) => l.upstream && remoteOf(l.upstream) === name).map((l) => l.name);
  const parts = [`Its ${plural(branches, 'remote branch leaves', 'remote branches leave')} this repository.`];
  if (tracking.length) {
    const lose = tracking.length === 1 ? 'tracking it loses its upstream' : 'tracking it lose their upstream';
    parts.push(`${plural(tracking.length, 'local branch', 'local branches')} ${lose}: ${namesUpTo3(tracking)}.`);
  }
  // Undo doesn't choose it again: the choice is the profile's, not the repository's.
  if (main) parts.push('The main remote goes back to Automatic.', 'Undo puts the rest back.');
  else parts.push('Undo puts it all back.');
  return { title: `Remove the remote ${name}?`, body: parts.join(' '), arm: `Click again to remove ${name}` };
}

/** Remove remote (the Remote panel's right-click): asked first, in place; journaled, so the
 * toast offers Undo. A main remote it was stops being chosen (back to Automatic), and the forge
 * state asks again. */
export async function removeRemote(ctx: WriteCtx, name: string): Promise<void> {
  const origin = currentOrigin();
  const rt = useRuntime.getState().tabs[ctx.tabId];
  const repoPath = rt?.repo?.path;
  const main = !!repoPath && useAppState.getState().profile.repos[repoPath]?.forgeTargetRemote === name;
  const text = removeRemoteText(name, rt?.sidebar ?? null, main);
  if (!(await confirmAction({ ...text, caption: text.body, confirmLabel: 'Remove remote', danger: true }, origin))) return;
  let removed = false;
  await runWrite(ctx, () => api.removeRemote(ctx.repoId, ctx.worktree, name), { origin, onSuccess: () => { removed = true; } });
  if (!removed) return;
  if (repoPath && useAppState.getState().profile.repos[repoPath]?.forgeTargetRemote === name) {
    useAppState.getState().updateRepo(repoPath, (r) => ({ ...r, forgeTargetRemote: null }));
    await flushSaves();
  }
  notifyForgeAccountsChanged();
}
