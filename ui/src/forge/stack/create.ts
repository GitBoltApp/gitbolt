import { GitPullRequestCreate } from 'lucide-react';
import { api, errorMessage } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { StackView } from '../../api/gen/StackView';
import type { CommitTarget, MenuEnv } from '../../menu/menuEnv';
import type { MenuRow } from '../../menu/types';
import type { Stack } from '../../stacks/detect';
import { joinNames } from '../../stacks/text';
import { nothingToPush } from '../../sync/push';
import type { WriteCtx } from '../../write/client';
import { mrNoun, mrRef } from '../labels';
import { isOpenMr, type MrOf } from './chain';
import { createMr, noteForgeWritten, type ForgeTarget } from './deps';

/** What Create stack does for each member, bottom → top (Ruling 7). */
export type MemberPlan =
  | { kind: 'create'; branch: string; target: string; title: string; description: string }
  | { kind: 'retarget'; branch: string; target: string; mr: ForgeMr }
  | { kind: 'ok'; branch: string; target: string; mr: ForgeMr }
  | { kind: 'merged'; branch: string; target: string; mr: ForgeMr };

export function memberPlans(view: StackView): MemberPlan[] {
  return view.members.map((m): MemberPlan => {
    const at = { branch: m.branch, target: m.targetBranch };
    if (m.mr?.state === 'merged') return { kind: 'merged', ...at, mr: m.mr };
    if (isOpenMr(m.mr)) return m.mr.targetBranch === m.targetBranch ? { kind: 'ok', ...at, mr: m.mr } : { kind: 'retarget', ...at, mr: m.mr };
    return { kind: 'create', ...at, title: m.prefill?.title || m.branch, description: m.prefill?.description ?? '' };
  });
}

const count = (n: number, kind: ForgeKind) => `${n} ${mrNoun(kind)}${n === 1 ? '' : 's'}`;

/** The submit button: `Create 3 MRs`, `Create 1 MR and retarget 1`, `Retarget 1 PR`; `null`: nothing to do. */
export function submitLabel(plans: readonly MemberPlan[], kind: ForgeKind): string | null {
  const c = plans.filter((p) => p.kind === 'create').length;
  const r = plans.filter((p) => p.kind === 'retarget').length;
  if (c && r) return `Create ${count(c, kind)} and retarget ${r}`;
  if (c) return `Create ${count(c, kind)}`;
  if (r) return `Retarget ${count(r, kind)}`;
  return null;
}

/** The forge branch a stack's base ref names: `refs/remotes/origin/main` → `main`. */
export function baseBranch(base: string, remote: string): string {
  if (base.startsWith(`refs/remotes/${remote}/`)) return base.slice(`refs/remotes/${remote}/`.length);
  if (base.startsWith('refs/heads/')) return base.slice('refs/heads/'.length);
  return base.replace(/^refs\/remotes\/[^/]+\//, '');
}

export interface CreateReport {
  created: number[];
  retargeted: number[];
  failed: { branch: string; action: 'create' | 'retarget'; message: string } | null;
  /** Members not reached after the failure. */
  rest: string[];
  /** Tables that couldn't be written (`number` 0: the whole sync failed). */
  table: { number: number; message: string }[];
}

/**
 * Create stack (spec #4 §4 4D, Rulings 6–7): bottom first, each member's MR/PR retargeted or
 * created through 4C's `createMr`. The first failure stops the rest. Then, for a managed stack,
 * one table sync over every member.
 */
export async function runCreateStack(ctx: WriteCtx, target: ForgeTarget, view: StackView, plans: readonly MemberPlan[], titles: Record<string, string>, draft: boolean): Promise<CreateReport> {
  const r: CreateReport = { created: [], retargeted: [], failed: null, rest: [], table: [] };
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    try {
      if (p.kind === 'retarget') {
        r.retargeted.push((await api.forgeRetarget(ctx.repoId, p.mr.number, p.target)).number);
        noteForgeWritten(ctx.tabId); // a poll already under way may predate this answer
      }
      else if (p.kind === 'create') {
        const out = await createMr(ctx, {
          remote: target.remote, source: { project: view.project, branch: p.branch }, targetBranch: p.target,
          title: (titles[p.branch] ?? p.title).trim(), description: p.description, draft, reviewers: [], assignees: [], labels: [], squash: null, deleteSourceBranch: null,
        });
        r.created.push(out.mr.number);
      }
    } catch (e) {
      r.failed = { branch: p.branch, action: p.kind === 'retarget' ? 'retarget' : 'create', message: errorMessage(e) };
      r.rest = plans.slice(i + 1).filter((q) => q.kind === 'create' || q.kind === 'retarget').map((q) => q.branch);
      break;
    }
  }
  if (view.mode === 'managed' && (r.created.length || r.retargeted.length)) {
    try {
      const s = await api.forgeSyncStack(ctx.repoId, view.members.map((m) => m.branch), view.members[0]?.targetBranch ?? '');
      r.table = s.failed.map((f) => ({ number: f.number, message: f.message }));
    } catch (e) {
      r.table = [{ number: 0, message: errorMessage(e) }];
    }
  }
  return r;
}

/** The one toast for a Create stack. */
export function createSummary(r: CreateReport, kind: ForgeKind): { message: string; detail?: string; error: boolean; warning: boolean } {
  const refs = (ns: number[]) => joinNames(ns.map((n) => mrRef(kind, n)));
  const done = [r.created.length ? `Created ${refs(r.created)}` : null, r.retargeted.length ? `${r.created.length ? 'retargeted' : 'Retargeted'} ${refs(r.retargeted)}` : null].filter((x) => x !== null);
  const failed = r.failed ? `${r.failed.branch}'s ${mrNoun(kind)} wasn't ${r.failed.action === 'create' ? 'created' : 'retargeted'}: ${r.failed.message}` : null;
  const rest = r.rest.length ? `not created: ${joinNames(r.rest)}` : null;
  const message = [...done, failed, rest].filter((x) => x !== null).join('; ');
  const detail = r.table.length ? r.table.map((t) => (t.number ? `Couldn't update the stack table in ${mrRef(kind, t.number)}: ${t.message}` : `Couldn't update the stack tables: ${t.message}`)).join(' ') : undefined;
  return { message, ...(detail ? { detail } : {}), error: !!r.failed, warning: !!detail };
}

/**
 * "Create stack MRs…" / "Create stack PRs…" on a stack member's chip (spec #4 §4 4D), in the Sync
 * group after Push stack. Hidden without a forge project or once every member has an open MR/PR
 * on the right target. Greyed while a member isn't pushed to the target remote (Ruling 5).
 */
export function createStackRow(t: CommitTarget, env: Pick<MenuEnv, 'stackOf' | 'sidebar' | 'inProgress'>, target: ForgeTarget | null, mrOf: MrOf, open: (s: Stack) => void): MenuRow[] {
  const name = t.branch?.local?.replace(/^refs\/heads\//, '');
  const stack = name ? env.stackOf?.(name) ?? null : null;
  const sb = env.sidebar;
  if (!stack || !target || !sb) return [];
  const base = baseBranch(stack.base, target.remote);
  const want = (i: number) => (i === 0 ? base : stack.branches[i - 1]);
  if (stack.branches.every((b, i) => { const m = mrOf(b); return isOpenMr(m) && m.targetBranch === want(i); })) return [];
  const noun = mrNoun(target.kind);
  const unpushed = stack.branches.some((n) => {
    const b = sb.locals.find((x) => x.name === n);
    return !b || !b.pushTarget?.startsWith(`${target.remote}/`) || !nothingToPush(b);
  });
  return [{
    kind: 'action', id: 'stack.forge.create', label: `Create stack ${noun}s…`, icon: GitPullRequestCreate,
    tooltip: `One ${noun} per branch, each targeting the branch below it`,
    disabledReason: env.inProgress ? `Finish or abort the ${env.inProgress} first` : stack.partial ? 'Load more history first' : unpushed ? 'Push the stack first' : undefined,
    run: () => open(stack),
  }];
}
