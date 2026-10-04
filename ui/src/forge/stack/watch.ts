import { activeTab } from '../../app/actions';
import { useRuntime } from '../../app/runtime';
import { useToast } from '../../ui/toast';
import { writeCtx } from '../../write/ctx';
import { mrNoun, mrRef } from '../labels';
import { firstAfterMerge } from './chain';
import { forgeTarget, useForge } from './deps';
import { inProgressOf, stackEnvOf } from './env';
import { worktreeDisplay } from '../../worktrees/paths';
import { afterMergeBlocked, retargetAndRebase } from './retarget';

/** `${repoId}:${merged number}`: prompted this session (Ruling 11). */
const prompted = new Set<string>();
export const resetPrompted = (): void => prompted.clear();

/**
 * The prompt's action: the toast may be old, so recompute from the runtime as it is now and refuse
 * BEFORE the (irreversible) forge write when HEAD moved, an operation is in progress, a member is
 * checked out elsewhere, or the stack changed.
 */
function rerun(tabId: string, mergedNumber: number): void {
  const target = forgeTarget(tabId);
  const rt = useRuntime.getState().tabs[tabId];
  const ctx = writeCtx(tabId);
  const sb = rt?.sidebar;
  const env = stackEnvOf(tabId);
  const toast = useToast.getState();
  if (!target || !env || !rt?.repo || !sb || !ctx) return toast.show("Couldn't retarget: the repository isn't ready", { error: true });
  const a = firstAfterMerge(env, (x) => x.merged.number === mergedNumber);
  if (!a) return toast.show(`${mrRef(target.kind, mergedNumber)} no longer has a stack to retarget and rebase`);
  const main = rt.graph?.worktrees.find((w) => w.isMain)?.path ?? rt.repo.path;
  const why = afterMergeBlocked(a, {
    headBranch: rt.graph?.head.branch?.replace(/^refs\/heads\//, '') ?? null,
    inProgress: inProgressOf(tabId),
    locals: sb.locals,
    worktreeShown: (p) => worktreeDisplay(main, p),
  });
  if (why) return toast.show(why, { error: true });
  void retargetAndRebase(ctx, a, target);
}

/**
 * The prompt after a stack's bottom MR/PR merges (spec #4 §4 4D): a sticky toast, once per
 * merged MR/PR per session, one at a time. Its action runs the flow when the top is checked out;
 * otherwise it says to check it out (the menu row and the MR/PR view stay as entry points).
 */
export function promptFor(tabId: string): void {
  const target = forgeTarget(tabId);
  const rt = useRuntime.getState().tabs[tabId];
  const env = stackEnvOf(tabId);
  if (!target || !env || !rt?.repo || !rt.sidebar || !writeCtx(tabId)) return;
  const repoId = rt.repo.id;
  const a = firstAfterMerge(env, (x) => !prompted.has(`${repoId}:${x.merged.number}`));
  if (!a) return;
  prompted.add(`${repoId}:${a.merged.number}`);
  const head = rt.graph?.head.branch?.replace(/^refs\/heads\//, '') ?? null;
  const merged = mrRef(target.kind, a.merged.number);
  const top = a.branches[a.branches.length - 1];
  if (head !== top) {
    useToast.getState().show(`${merged} was merged: check out ${top} to ${a.retarget ? `retarget ${mrRef(target.kind, a.next.number)} and rebase the stack` : 'rebase the stack'}`, { sticky: true });
  } else {
    const label = a.retarget ? `Retarget the next ${mrNoun(target.kind)} and rebase the stack` : `Rebase the stack without ${merged}`;
    useToast.getState().show(`${merged} was merged.`, { sticky: true, action: { label, run: () => { void rerun(tabId, a.merged.number); } } });
  }
}

/**
 * Reacts to 4B's forge store (its poller's updates) for the active tab: only when that tab's
 * badges (`byRef`, `upstreams`) or list changed, or the store changed with another tab active
 * than last time (a merge seen while the tab was in the background). Returns the stop.
 */
export function startAfterMergeWatch(): () => void {
  let queued = false;
  let lastTab: string | null = null;
  return useForge.subscribe((s, prev) => {
    const t = activeTab();
    if (t?.kind !== 'repo' || queued) return;
    const now = s.byTab[t.id];
    const was = prev.byTab[t.id];
    const same = now === was || (now?.byRef === was?.byRef && now?.upstreams === was?.upstreams && now?.list === was?.list);
    if (same && lastTab === t.id) return;
    lastTab = t.id;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const cur = activeTab();
      if (cur?.kind === 'repo') promptFor(cur.id);
    });
  });
}
