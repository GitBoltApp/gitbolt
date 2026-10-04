// ui/src/stacks/push.ts
import { ArrowUpFromLine } from 'lucide-react';
import { api } from '../api/client';
import type { GbError } from '../api/gen/GbError';
import type { LocalBranch } from '../api/gen/LocalBranch';
import { openDebug } from '../app/activityLog';
import { useRuntime } from '../app/runtime';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import type { MenuRow } from '../menu/types';
import { branchOf, defaultRemote, nothingToPush, pushBranch, rewroteSincePush } from '../sync/push';
import { serverActions } from '../sync/serverOutput';
import { currentOrigin } from '../ui/arm/origin';
import { useToast, type ToastAction } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';
import type { Stack } from './detect';
import { joinNames } from './text';

export interface PushStep { name: string; result: 'pushed' | 'forced' | 'published' | 'upToDate' }
export interface StackPushReport { steps: PushStep[]; failed: { name: string; error: GbError } | null; rest: string[]; remote: string; /** The servers' warnings, as pushed (4D's after-merge toast keeps them). */ warnings: string[] }

/** The one toast for a Push stack: which pushed, how, and where it stopped. */
export function pushSummary(r: StackPushReport): { message: string; detail?: string; error: boolean } {
  const of = (k: PushStep['result']) => r.steps.filter((s) => s.result === k).map((s) => s.name);
  const sent = r.steps.filter((s) => s.result !== 'upToDate').map((s) => s.name);
  if (r.failed) {
    const cancelled = r.failed.error.kind === 'Cancelled';
    const parts = [sent.length ? `Pushed ${joinNames(sent)}` : null, `${r.failed.name} ${cancelled ? 'was cancelled' : 'was refused'}`, r.rest.length ? `not pushed: ${joinNames(r.rest)}` : null];
    return { message: parts.filter((p) => p !== null).join('; '), detail: cancelled ? undefined : r.failed.error.message, error: !cancelled };
  }
  if (sent.length === 0) return { message: 'The stack is up to date', error: false };
  const forced = of('forced');
  const published = of('published');
  const notes = [forced.length ? `force with lease: ${joinNames(forced)}` : null, published.length ? `new on ${r.remote}: ${joinNames(published)}` : null].filter((n) => n !== null);
  return { message: `Pushed ${joinNames(sent)}${notes.length ? ` (${notes.join('; ')})` : ''}`, error: false };
}

/** Where a member with no push target is published: the base's remote, else the default one. */
export function publishRemote(tabId: string, base: string): string {
  const names = (useRuntime.getState().tabs[tabId]?.sidebar?.remotes ?? []).map((g) => g.name);
  const own = names.filter((n) => base.startsWith(`refs/remotes/${n}/`)).sort((a, b) => b.length - a.length)[0];
  return own ?? defaultRemote(tabId);
}

/**
 * Push stack (spec #3 §3.11): #2's Push for each member, bottom first. The core's push decision
 * applies per branch: a live rewrite mark forces with its recorded lease; a member with no push
 * target is published and tracked. Members with nothing to push are skipped. The first failure
 * stops the sequence, and one toast says which pushed and which didn't. Resolves the report (4D chains on it).
 */
export async function pushStack(ctx: WriteCtx, stack: Stack): Promise<StackPushReport> {
  const origin = currentOrigin();
  const warned: string[] = [];
  const report: StackPushReport = { steps: [], failed: null, rest: [], remote: publishRemote(ctx.tabId, stack.base), warnings: warned };
  let lastOutput: ToastAction[] = [];
  for (let i = 0; i < stack.branches.length; i++) {
    const name = stack.branches[i];
    const b = branchOf(ctx.tabId, name);
    const stop = (error: GbError) => { report.failed = { name, error }; report.rest = stack.branches.slice(i + 1); };
    if (!b) { stop({ kind: 'NotFound', message: `${name} no longer exists`, commandId: null, stderr: null }); break; }
    if (nothingToPush(b)) { report.steps.push({ name, result: 'upToDate' }); continue; }
    const publish = !b.pushTarget;
    const failure: { error: GbError | null } = { error: null };
    const opts = { ...(publish ? { target: { remote: report.remote, branch: name }, setUpstream: true } : {}), expect: { head: null, refs: { [b.fullName]: b.target } } };
    const out = await runWrite(ctx, () => api.push(ctx.repoId, ctx.worktree, name, opts), { origin, handle: (e) => { failure.error = e; return true; } });
    if (!out) { stop(failure.error ?? { kind: 'Cancelled', message: 'Cancelled', commandId: null, stderr: null }); break; }
    report.steps.push({ name, result: out.upToDate ? 'upToDate' : out.forced ? 'forced' : publish ? 'published' : 'pushed' });
    if (out.server.warning) { warned.push(out.server.warning); lastOutput = serverActions(out.server, out.op); }
  }
  const s = pushSummary(report);
  const failed = report.failed;
  if (!failed && warned.length) {
    useToast.getState().show(`${s.message}; the server reported a problem`, { tone: 'warning', sticky: true, detail: warned.map((w) => `“${w}”`).join(' '), actions: lastOutput });
    return report;
  }
  const actions: ToastAction[] = [];
  if (failed && failed.error.kind !== 'Cancelled') {
    const b = branchOf(ctx.tabId, failed.name);
    // The single-branch push, with its own Pull / Force push choice (spec #2 §12.3).
    if (b && (failed.error.kind === 'NonFastForward' || failed.error.kind === 'RefMoved')) actions.push({ label: `Push ${failed.name}…`, run: () => { void pushBranch(ctx, b); } });
    if (failed.error.commandId !== null) actions.push({ label: 'Details', run: () => openDebug('commands', failed.error.commandId) });
  }
  const detail = [...warned.map((w) => `“${w}”`), s.detail].filter((x) => !!x).join(' ') || undefined;
  useToast.getState().show(s.message, { error: s.error, detail, actions });
  return report;
}

/**
 * "Push stack" on a stack member's chip (spec #3 §4.3), in the Sync group after Push. Shown when
 * the branch is stacked, the repository has a remote and a member has something to push. Greyed
 * while a member is checked out in another worktree (§5: stack pushes never act on those).
 */
export function pushStackRow(t: CommitTarget, env: Pick<MenuEnv, 'stackOf' | 'sidebar' | 'worktreeShown'> & Partial<Pick<MenuEnv, 'inProgress'>>, run: (s: Stack) => void): MenuRow[] {
  const name = t.branch?.local?.replace(/^refs\/heads\//, '');
  const stack = name ? env.stackOf?.(name) ?? null : null;
  const sb = env.sidebar;
  if (!stack || !sb || sb.remotes.length === 0) return [];
  const members = stack.branches.map((n) => sb.locals.find((b) => b.name === n));
  if (members.some((b) => !b)) return [];
  const locals = members as LocalBranch[];
  if (locals.every(nothingToPush)) return [];
  const away = locals.find((b) => b.worktree);
  const forced = locals.filter((b) => rewroteSincePush(b)).map((b) => b.name);
  return [{
    kind: 'action', id: 'stack.push', label: 'Push stack', icon: ArrowUpFromLine,
    tooltip: `Push ${stack.branches.join(' → ')}, bottom first${forced.length ? ` (force with lease: ${joinNames(forced)})` : ''}`,
    disabledReason: env.inProgress ? `Finish or abort the ${env.inProgress} first` : away ? `${away.name} is checked out in ${env.worktreeShown(away.worktree!)}` : undefined,
    run: () => run(stack),
  }];
}
