import { GitBranchPlus } from 'lucide-react';
import { useRef } from 'react';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { createBranchAt } from '../branches/create';
import { mrLongNoun } from '../forge/labels';
import { effectiveKind } from '../forge/urls';
import { useRepoContext } from '../app/repoContext';
import { useAppState } from '../app/state';
import { useRepoView } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import type { WriteCtx } from '../write/client';

/** The local trunk branch `worktree` has checked out in a fork (the core's
 * `ForkPayload.trunkBranches`), with its HEAD; `null` when it's on any other branch, or not a fork. */
export function forkTrunkBranch(graph: Pick<GraphPayload, 'fork' | 'worktrees'>, worktree: string): { branch: string; head: string } | null {
  const w = graph.worktrees?.find((x) => x.path === worktree);
  if (!graph.fork || !w?.branch || !w.head || !graph.fork.trunkBranches.includes(w.branch)) return null;
  return { branch: w.branch, head: w.head };
}

/**
 * Above the Commit button, in a fork, while the worktree is on a trunk branch (its `main`): a
 * commit there goes to your fork's main, and a pull request from it is awkward (a merge request
 * on GitLab: the original project's forge, the profile's host overrides applied). Non-blocking:
 * Create branch… (the inline new-branch flow from HEAD, which keeps what's staged; no start ref,
 * so the new branch doesn't track the local main) or Dismiss, remembered for the repo, which hands
 * the keyboard to Commit.
 */
export function ForkTrunkNotice({ ctx }: { ctx: WriteCtx }) {
  const { path } = useRepoContext();
  const box = useRef<HTMLDivElement>(null);
  const fork = useRepoView((s) => s.graph.fork);
  const worktrees = useRepoView((s) => s.graph.worktrees);
  const on = forkTrunkBranch({ fork, worktrees }, ctx.worktree);
  const dismissed = useAppState((s) => !!s.profile.repos[path]?.forkTrunkNoticeDismissed);
  const overrides = useAppState((s) => s.profile.hostOverrides);
  if (!on || !fork || dismissed) return null;
  const noun = mrLongNoun(effectiveKind(fork.host, fork.hostKind, overrides) === 'gitlab' ? 'gitlab' : 'github');
  const name = on.branch.replace(/^refs\/heads\//, '');
  const dismiss = () => {
    const commit = box.current?.closest('.commit-box')?.querySelector<HTMLButtonElement>('.commit-button');
    useAppState.getState().updateRepo(path, (r) => ({ ...r, forkTrunkNoticeDismissed: true }));
    commit?.focus();
  };
  return (
    <div ref={box} className="commit-notice" role="note" data-testid="fork-trunk-notice">
      <span>You're committing to {name} in your fork. Changes for a {noun} usually go on their own branch.</span>
      <div className="commit-notice-actions">
        <HoverTooltip content={`Create a branch at ${name}'s tip and switch to it: what's staged and changed comes along`}>
          <button type="button" className="commit-notice-action" onClick={() => void createBranchAt(ctx, { sha: on.head, ref: null }, { keepSelection: true })}>
            <GitBranchPlus size={12} aria-hidden />
            Create branch…
          </button>
        </HoverTooltip>
        <HoverTooltip content="Don't show this again for this repository">
          <button type="button" className="commit-notice-action" onClick={dismiss}>Dismiss</button>
        </HoverTooltip>
      </div>
    </div>
  );
}
