import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { remoteShort } from './refNames';

/** The branch a commit belongs to (feedback F7): shown as a dimmed chip on a hovered or selected
 * row that isn't that branch's tip. `color` is the tip row's lane colour index; `ref` the full
 * ref (`refs/heads/main`, `refs/remotes/origin/main`). */
export interface BranchMembership {
  name: string;
  color: number;
  ref: string;
}

/** The graph's labels, grouped by row (payload order kept). */
export function labelsByRow(labels: RefLabel[]): Map<number, RefLabel[]> {
  const m = new Map<number, RefLabel[]>();
  for (const l of labels) {
    const list = m.get(l.row);
    if (list) list.push(l);
    else m.set(l.row, [l]);
  }
  return m;
}

/** A branch that claims its first-parent history. `rank` orders the claimants (lower first). */
interface Claimant {
  tip: number;
  rank: number;
  membership: BranchMembership;
}

const REMOTES = /^refs\/remotes\//;

/**
 * Per row, the branch it belongs to when it's not that branch's own tip, else null. Each branch
 * claims its first-parent history, independent of lanes: in claimant order, walk from the tip
 * down the first parents, claiming every row until one is already claimed. Every row is claimed
 * at most once, so the whole thing is O(rows + labels).
 *
 * Claimant order:
 * 0. the trunk's local branch: the local branch named like the pinned trunk's branch (`main`
 *    for a pinned `origin/main`), else the pinned ref itself. With no trunk (an unpinned repo,
 *    or a pinned override that isn't a branch ref), the checked-out (HEAD) local branch. So
 *    `main` keeps its history even when `hotfix`, forked off main's tip, took main's own lane
 *    (unpinned) or is newer than main's unpushed commits;
 * 1. the pinned ref itself, if it's a branch ref not already rank 0: when local main is behind
 *    origin/main, origin/main claims its own commits before a branch forked off it can;
 * 2. the other local branches, newest tip first;
 * 3. remote branches with no local branch of that name (`origin/topic`), newest tip first;
 * 4. the remaining remote branches (`upstream/main` next to a local `main`): they get only what
 *    nobody else claimed, i.e. their own commits ahead of it.
 *
 * Tags and a detached `HEAD` never claim. Unclaimed rows (a deleted branch's merged side
 * history, stash and WIP rows) get none.
 */
export function branchMembership(rows: RowPayload[], labels: Map<number, RefLabel[]>, pinnedRef: string | null = null): (BranchMembership | null)[] {
  const n = rows.length;
  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) index.set(rows[i].id, i);
  // fp[i]: row i's first parent's row, -1 if it isn't loaded (or row i has none).
  const fp = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = rows[i].parents[0];
    if (p !== undefined) fp[i] = index.get(p) ?? -1;
  }

  const locals: { name: string; ref: string; tip: number; head: boolean }[] = [];
  const remotes: { name: string; branch: string; ref: string; tip: number }[] = [];
  for (const [row, list] of labels) {
    for (const l of list) {
      if (l.tag) continue;
      if (l.local !== null) locals.push({ name: l.name, ref: l.local, tip: row, head: l.isHead });
      for (const r of l.remotes) remotes.push({ name: remoteShort(r), branch: r.fullName.slice(`refs/remotes/${r.remote}/`.length), ref: r.fullName, tip: row });
    }
  }
  const localNames = new Set(locals.map((l) => l.name));

  // Rank 0: the trunk's local branch, else the pinned ref itself. Rank 1: the pinned ref, when
  // it's a branch ref that isn't rank 0 already (a local main BEHIND origin/main must not let
  // another local branch forked off origin/main claim origin/main's own commits). A pinned
  // override that is neither `refs/heads/` nor `refs/remotes/` (e.g. a tag) isn't a branch: it
  // pins nothing here, and HEAD's branch goes first, as with no trunk at all.
  const pinnedBranch = pinnedRef?.startsWith('refs/heads/') || (pinnedRef && REMOTES.test(pinnedRef)) ? pinnedRef : null;
  let trunkRef: string | null = null;
  if (pinnedBranch?.startsWith('refs/heads/')) trunkRef = pinnedBranch;
  else if (pinnedBranch) {
    // Its branch part, exact from its label (a remote name may contain `/`), else from the name.
    const branch = remotes.find((r) => r.ref === pinnedBranch)?.branch ?? pinnedBranch.replace(/^refs\/remotes\/[^/]+\//, '');
    trunkRef = locals.find((l) => l.name === branch)?.ref ?? pinnedBranch;
  } else trunkRef = locals.find((l) => l.head)?.ref ?? null;

  const claimants: Claimant[] = [];
  const add = (tip: number, rank: number, name: string, ref: string) => claimants.push({ tip, rank, membership: { name, color: rows[tip].color, ref } });
  const top = (ref: string) => (ref === trunkRef ? 0 : ref === pinnedBranch ? 1 : -1);
  for (const l of locals) add(l.tip, top(l.ref) >= 0 ? top(l.ref) : 2, l.name, l.ref);
  for (const r of remotes) add(r.tip, top(r.ref) >= 0 ? top(r.ref) : localNames.has(r.branch) ? 4 : 3, r.name, r.ref);
  // Within a rank, newest tip (lowest row) first. Stable, so payload order breaks ties.
  claimants.sort((a, b) => a.rank - b.rank || a.tip - b.tip);

  const claim: (Claimant | null)[] = new Array(n).fill(null);
  for (const c of claimants) {
    for (let r = c.tip; r >= 0 && claim[r] === null; r = fp[r]) claim[r] = c;
  }
  return claim.map((c, i) => (c && c.tip !== i ? c.membership : null));
}
