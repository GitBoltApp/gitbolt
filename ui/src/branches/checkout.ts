import { api } from '../api/client';
import type { CheckoutTarget } from '../api/gen/CheckoutTarget';
import type { Expect } from '../api/gen/Expect';
import type { GbError } from '../api/gen/GbError';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { useRuntime, worktreeOf } from '../app/runtime';
import { tabIdOf } from '../app/tabStores';
import type { RepoViewStore } from '../repo/store';
import type { SidebarCtx } from '../sidebar/itemActions';
import type { SideItem } from '../sidebar/model';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { confirmAction } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast';
import { openWorktreeTab, setActiveWorktree } from '../worktrees/active';
import { runWrite, type WriteCtx } from '../write/client';

/** "feature/x is checked out in ../shop-feature-x." [Switch to it] [Open in a new tab] (§9.3). */
function offerWorktree(ctx: WriteCtx, err: GbError): boolean {
  const d = err.detail;
  if (d?.kind !== 'checkedOutElsewhere') return false;
  const path = useRuntime.getState().tabs[ctx.tabId]?.graph?.worktrees.find((w) => w.branch === `refs/heads/${d.branch}`)?.path;
  if (!path) return false;
  useToast.getState().show(err.message, {
    error: true,
    actions: [
      { label: 'Switch to it', run: () => setActiveWorktree(ctx.tabId, path) },
      { label: 'Open in a new tab', run: () => { void openWorktreeTab(ctx.tabId, path); } },
    ],
  });
  return true;
}

/** One checkout (§9.3); the backend resolves the case when it runs. Diverged asks Reset/Cancel.
 * A repository in the way ("<path> is a repository in the way of the checkout: move it first") is
 * a plain refusal: the error toast shows it, with no Retry and nothing to force. */
export async function checkout(ctx: WriteCtx, target: CheckoutTarget, expect: Expect, onDiverged?: 'reset', origin: Origin | null = currentOrigin()): Promise<void> {
  // `origin`: where it started; the question comes after the backend's answer (spec §ui confirms).
  const out = await runWrite(ctx, (ok) => api.checkout(ctx.repoId, ctx.worktree, target, expect, ok, onDiverged), { handle: (err) => offerWorktree(ctx, err), origin });
  if (out?.status !== 'diverged') return;
  const ok = await confirmAction({
    title: 'Branches have diverged',
    body: `${out.local} and ${out.remote} have diverged (${out.ahead} ahead, ${out.behind} behind).`,
    confirmLabel: `Reset ${out.local} to ${out.remote}`,
    arm: `Click again to reset ${out.local} to ${out.remote}${out.ahead ? ` (drops ${out.ahead} local ${out.ahead === 1 ? 'commit' : 'commits'})` : ''}`,
    caption: `${out.local} and ${out.remote} have diverged (${out.ahead} ahead, ${out.behind} behind).`,
    danger: true,
  }, origin);
  // The Reset resend pins both refs to the oids the dialog showed; the core refuses without them.
  if (ok) {
    const refs = { [`refs/heads/${out.local}`]: out.localOid, [`refs/remotes/${out.remote}`]: out.remoteOid };
    await checkout(ctx, target, { head: expect.head, refs }, 'reset', origin);
  }
}

const ctxOf = (tabId: string): WriteCtx | null => {
  const rt = useRuntime.getState().tabs[tabId];
  const worktree = worktreeOf(rt);
  return rt?.repo && worktree ? { tabId, repoId: rt.repo.id, worktree } : null;
};
const headOf = (tabId: string) => useRuntime.getState().tabs[tabId]?.graph?.head.target ?? null;
const shortLocal = (full: string) => full.replace(/^refs\/heads\//, '');

/** A branch chip's double-click (§9.3): its local branch, else its remote one. Tags aren't branches. */
export function checkoutLabel(store: RepoViewStore, row: RowPayload, label: RefLabel): boolean {
  const tabId = tabIdOf(store);
  const ctx = tabId ? ctxOf(tabId) : null;
  if (!ctx || label.tag || (!label.local && label.remotes.length === 0)) return false;
  if (label.isHead) return true; // already checked out: nothing to do
  // Checked out in another worktree: go there (the refusal toast's Switch to it, done directly).
  if (label.local && label.worktree) {
    setActiveWorktree(ctx.tabId, label.worktree);
    return true;
  }
  const head = headOf(ctx.tabId);
  if (label.local) {
    void checkout(ctx, { kind: 'branch', name: shortLocal(label.local) }, { head, refs: { [label.local]: row.id } });
  } else {
    const r = label.remotes.find((x) => x.remote === 'origin') ?? label.remotes[0];
    const branch = r.fullName.slice(`refs/remotes/${r.remote}/`.length);
    void checkout(ctx, { kind: 'remote', remote: r.remote, branch }, { head, refs: { [r.fullName]: row.id } });
  }
  return true;
}

/** A sidebar branch row's double-click (§19 item 6). */
export function checkoutSideItem({ tabId }: SidebarCtx, item: SideItem): void {
  const ctx = ctxOf(tabId);
  if (!ctx || !item.target) return;
  if (item.kind === 'local' && item.branch.isHead) return;
  if (item.kind === 'local' && item.branch.worktree) {
    setActiveWorktree(tabId, item.branch.worktree);
    return;
  }
  const head = headOf(tabId);
  if (item.kind === 'local') void checkout(ctx, { kind: 'branch', name: item.branch.name }, { head, refs: { [item.branch.fullName]: item.target } });
  if (item.kind === 'remote') void checkout(ctx, { kind: 'remote', remote: item.remote, branch: item.branch.name }, { head, refs: { [item.branch.fullName]: item.target } });
}

/** The toolbar branch picker and the palette: a local branch by name. */
export function checkoutLocal(tabId: string, name: string): void {
  const ctx = ctxOf(tabId);
  const b = useRuntime.getState().tabs[tabId]?.sidebar?.locals.find((l) => l.name === name);
  if (ctx && b) void checkout(ctx, { kind: 'branch', name }, { head: headOf(tabId), refs: { [b.fullName]: b.target } });
}

/** The palette's `@origin/x`: the remote branch. */
export async function checkoutRemote(tabId: string, remote: string, branch: string, target: string, local?: string): Promise<void> {
  const ctx = ctxOf(tabId);
  if (ctx) await checkout(ctx, { kind: 'remote', remote, branch, ...(local ? { local } : {}) }, { head: headOf(tabId), refs: { [`refs/remotes/${remote}/${branch}`]: target } });
}
