import { GitPullRequest } from 'lucide-react';
import { api } from '../api/client';
import type { LocalBranch } from '../api/gen/LocalBranch';
import type { PullMode } from '../api/gen/PullMode';
import type { PullOutcome } from '../api/gen/PullOutcome';
import type { SyncButtonMode } from '../api/gen/SyncButtonMode';
import type { MenuRow } from '../menu/types';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { askChoice } from '../ui/ChoiceDialog';
import { ERROR_TOAST_MS, useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';
import { headBranchOf } from './push';
import { showServerResult } from './serverOutput';

type PullButtonMode = Exclude<SyncButtonMode, 'fetchAll'>;
const MODE_TEXT: Record<PullButtonMode, string> = { pullFfOrMerge: 'fast-forward if possible', pullFfOnly: 'fast-forward only', pullRebase: 'rebase' };
export const MODE_OF: Record<PullButtonMode, PullMode> = { pullFfOrMerge: 'ffOrMerge', pullFfOnly: 'ffOnly', pullRebase: 'rebase' };
const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;
const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;
/** The upstream as the user reads it (`origin/main`): the snapshot spells it as the full ref. */
const upstreamOf = (b: LocalBranch): string | null => b.upstream?.replace(/^refs\/remotes\//, '') ?? null;

/** The Fetch/Pull button's caption, tooltip and whether it's disabled (spec #2 §12.1). */
export function syncView(mode: SyncButtonMode, b: LocalBranch | undefined, head: string | null): { label: string; tooltip: string; disabled: boolean } {
  if (mode === 'fetchAll') return { label: 'Fetch', tooltip: 'Fetch every remote', disabled: false };
  if (!b || !head) return { label: 'Pull', tooltip: 'HEAD is detached', disabled: true };
  if (!b.upstream) return { label: 'Pull', tooltip: `${b.name} has no upstream; set one from Push ▾`, disabled: true };
  return { label: 'Pull', tooltip: `Pull ${upstreamOf(b)} into ${b.name} (${MODE_TEXT[mode]})`, disabled: false };
}

async function done(ctx: WriteCtx, o: PullOutcome, origin: Origin | null): Promise<void> {
  const r = o.result;
  const say = (text: string) => showServerResult(text, `${text}; the server reported a problem`, o.server, o.op);
  switch (r.status) {
    case 'upToDate':
      return say(r.ahead ? `${o.branch} is up to date (${r.ahead} ahead: push)` : `${o.branch} is up to date`);
    case 'fastForward':
      return say(`Pulled ${commits(r.commits)} into ${o.branch} (fast-forward)`);
    case 'merged':
      return say(`Pulled ${commits(r.commits)} into ${o.branch} (merge)`);
    case 'rebased':
      return say(`Pulled ${commits(r.commits)} into ${o.branch} (rebase)`);
    case 'stopped':
      return; // the banner (§13.2)
    case 'diverged': {
      // Integrate works on the checked-out branch: for another branch there is nothing to ask.
      if (headBranchOf(ctx.tabId) !== o.branch) {
        useToast.getState().show(`${o.branch} and ${o.upstream} have diverged; check out ${o.branch} first`, { ms: ERROR_TOAST_MS });
        return;
      }
      const answer = await askChoice({
        title: `Pull ${o.branch}?`,
        body: `${o.branch} and ${o.upstream} have diverged (${r.ahead} ahead, ${r.behind} behind).`,
        note: r.conflicts ? `Merging would conflict in ${files(r.conflicts)}.` : undefined,
        choices: [{ id: 'rebase', label: 'Rebase', primary: true }, { id: 'merge', label: 'Merge' }],
      }, origin);
      if (answer.choice !== 'rebase' && answer.choice !== 'merge') return;
      const kind = answer.choice;
      // Locally: the fetch just happened, so no second one.
      const out = await runWrite(ctx, (_, asked) => api.integrate(ctx.repoId, ctx.worktree, kind, o.upstream, { confirmAutostash: asked.autostash }), { origin });
      if (out?.status === 'done') say(`Pulled ${commits(r.behind)} into ${o.branch} (${kind})`);
    }
  }
}

/** Pull `branch` (the checked-out one by default) in `mode` (spec #2 §12.2). */
export async function pull(ctx: WriteCtx, mode: PullMode, branch?: string): Promise<void> {
  // Where it started: a diverged pull asks there, after the fetch (spec §ui confirms).
  const origin = currentOrigin();
  const out = await runWrite(ctx, (_, asked) => api.pull(ctx.repoId, ctx.worktree, mode, { branch, confirmAutostash: asked.autostash }));
  if (out) await done(ctx, out, origin);
}

/** The Sync group's `Pull | ff-only | rebase | merge |` (§12.2): the label click is ff-only. Not
 * offered without an upstream to pull from (none, or gone); rebase and merge only for the
 * checked-out branch (another is fast-forwarded in place). */
export function pullRow(b: LocalBranch, run: (mode: PullMode) => void): MenuRow | null {
  if (!b.upstream || b.gone) return null;
  const up = upstreamOf(b);
  return {
    kind: 'action', id: 'sync.pull', label: 'Pull', icon: GitPullRequest, tooltip: `Pull ${up ?? 'its upstream'} into ${b.name} (fast-forward only)`, run: () => run('ffOnly'),
    variants: [
      { id: 'ffOnly', label: 'ff-only', tooltip: 'Fast-forward only', run: () => run('ffOnly') },
      ...(b.isHead ? [
        { id: 'rebase', label: 'rebase', tooltip: `Rebase ${b.name} onto ${up}`, run: () => run('rebase') },
        { id: 'merge', label: 'merge', tooltip: `Merge ${up} into ${b.name}`, run: () => run('ffOrMerge') },
      ] : []),
    ],
  };
}
