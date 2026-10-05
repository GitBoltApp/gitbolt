import { api } from '../../api/client';
import type { CreateMr } from '../../api/gen/CreateMr';
import type { CreateOutcome } from '../../api/gen/CreateOutcome';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeProject } from '../../api/gen/ForgeProject';
import { useRuntime } from '../../app/runtime';
import type { WriteCtx } from '../../write/client';
import { forgeOf, mrForLabel, noteForgeWritten } from '../mrStore';
export { noteForgeWritten };
import { notifyForgeWrite } from '../usePolling';

/**
 * 4D's only imports from 4B and 4C (plan 4D, "Interfaces used from 4B and 4C" A1–A4). Everything
 * else in `forge/stack/` imports them from here, so a renamed name is a change to this file only.
 */
export { useForge, useTabForge, useTabForgeField } from '../mrStore'; // A1: 4B's zustand store (`byTab`)
export { openMrView } from '../poll'; // A2 (4B): (tabId, number) => void

/** The tab's target project (A4): 4B's `forgeOf`, once its poller found an account for it. */
export interface ForgeTarget { remote: string; kind: ForgeKind; project: ForgeProject }
export function forgeTarget(tabId: string): ForgeTarget | null {
  const { remote, kind, project } = forgeOf(tabId);
  return remote && kind && project ? { remote, kind, project } : null;
}

/**
 * A branch's newest MR/PR in the target project, any state (A1): through the branch's remote
 * refs (4B's open list) or its local branch's upstream (4B's any-state lookups).
 */
export function branchMr(tabId: string, branch: string): ForgeMr | null {
  return branchMrs(tabId)(branch);
}

/**
 * `branchMr` for one pass (the chain, the after-merge flow): the tab's branches indexed once,
 * each answer kept. A branch gone locally and on the remote (a merged bottom, cleaned up) is
 * still found through `refs/remotes/<target remote>/<branch>`, which the poll asks about as the
 * target of an open MR/PR (`upstreamRefsOf`).
 */
export function branchMrs(tabId: string): (branch: string) => ForgeMr | null {
  const sb = useRuntime.getState().tabs[tabId]?.sidebar;
  const tab = forgeOf(tabId);
  // The badges, then the merged or closed MRs/PRs that badge nothing (a merged bottom whose branch is gone).
  const f = { ...tab, byRef: { ...tab.history, ...tab.byRef } };
  const locals = new Map((sb?.locals ?? []).map((l) => [l.name, l.fullName]));
  const remotes = new Map<string, { fullName: string }[]>();
  for (const g of sb?.remotes ?? []) for (const b of g.branches) remotes.set(b.name, [...(remotes.get(b.name) ?? []), b]);
  const memo = new Map<string, ForgeMr | null>();
  return (branch) => {
    const hit = memo.get(branch);
    if (hit !== undefined) return hit;
    const mr = mrForLabel(f, { local: locals.get(branch) ?? null, remotes: remotes.get(branch) ?? [] })?.mr ?? (f.remote ? f.byRef[`refs/remotes/${f.remote}/${branch}`] : undefined) ?? null;
    memo.set(branch, mr);
    return mr;
  };
}

/** Create one MR/PR (A3: 4C's `forgeCreateMr`); the poller polls at once, as after 4C's own create. */
export type MrDraft = { remote: string } & CreateMr;
export async function createMr(ctx: WriteCtx, { remote, ...req }: MrDraft): Promise<CreateOutcome> {
  const out = await api.forgeCreateMr(ctx.repoId, remote, req);
  noteForgeWritten(ctx.tabId); // a poll already under way may predate this answer
  notifyForgeWrite(ctx.tabId);
  return out;
}
