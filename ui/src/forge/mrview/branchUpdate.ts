import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { BranchUpdate } from '../../api/gen/BranchUpdate';
import type { BranchUpdateOffer } from '../../api/gen/BranchUpdateOffer';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { MergeMethod } from '../../api/gen/MergeMethod';
import { useRuntime } from '../../app/runtime';

/**
 * The merge panel's update button's main way: the one last chosen in this repository (when the
 * forge offers it), else on GitHub a rebase when the repository allows rebase merges (its merge
 * methods), else a merge; on GitLab, Rebase.
 */
export function defaultUpdate(kind: ForgeKind, kinds: readonly BranchUpdate[], saved: BranchUpdate | null | undefined, methods: readonly MergeMethod[]): BranchUpdate | null {
  if (saved && kinds.includes(saved)) return saved;
  const want: BranchUpdate = kind === 'github' && !methods.includes('rebase') ? 'merge' : 'rebase';
  return kinds.includes(want) ? want : kinds[0] ?? null;
}

/**
 * Whether the source branch is behind its target: the commits say when the repository has them
 * (`local`); the forge's own word otherwise. Behind either way when the forge says so: the
 * target's remote-tracking ref may be older than the forge's target (not fetched since).
 */
export function branchBehind(local: boolean | null, offer: BranchUpdateOffer): boolean {
  return local === true || offer.forgeBehind;
}

/** What the commits say (`useLocalBehind`): behind or not, can't tell (null), or not answered yet. */
export type LocalBehind = boolean | null | 'pending';

/** Answers kept across remounts (a view shown again starts with them, and asks nothing): repo,
 * target tip, head. Only answers: "can't tell" (commits missing) is asked again. */
const seen = new Map<string, boolean>();
const SEEN_MAX = 200;

/**
 * Whether `head` lacks the tip of `remote`'s `target` branch (its remote-tracking ref, as the
 * sidebar has it): a local merge-base, no forge request. null: the repository lacks one of them
 * (the MR's commits not fetched), or it couldn't tell; asked again when the sidebar reloads (a
 * fetch), so commits fetched since are picked up.
 */
export function useLocalBehind(tabId: string, remote: string | null, target: string, head: string | null): LocalBehind {
  const repo = useRuntime((s) => s.tabs[tabId]?.repo?.id);
  const sidebar = useRuntime((s) => s.tabs[tabId]?.sidebar);
  const tip = remote ? sidebar?.remotes.find((g) => g.name === remote)?.branches.find((b) => b.name === target)?.target ?? null : null;
  const key = repo !== undefined && tip && head ? `${repo}\0${tip}\0${head}` : null;
  const [answer, setAnswer] = useState<{ key: string; behind: boolean | null } | null>(null);
  useEffect(() => {
    if (!key || repo === undefined || !tip || !head || seen.has(key)) return;
    let live = true;
    api.mergeBase(repo, tip, head).then(
      (base) => (base ? base !== tip : null),
      () => null,
    ).then((behind) => {
      if (behind !== null) {
        seen.delete(key);
        seen.set(key, behind);
        if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
      }
      if (live) setAnswer({ key, behind });
    });
    return () => { live = false; };
  }, [key, repo, tip, head, sidebar]);
  if (!key) return null;
  const known = seen.get(key);
  if (known !== undefined) return known;
  return answer?.key === key ? answer.behind : 'pending';
}

/** Tests only. */
export const clearLocalBehind = (): void => seen.clear();
