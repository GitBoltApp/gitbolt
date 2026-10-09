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

/** The branch refs a chip stands for (J22 branch-hover focus): its local branch and every
 * remote-tracking one it carries. A tag or a detached HEAD stands for none. */
export function chipRefs(label: RefLabel): string[] {
  if (label.tag) return [];
  return [...(label.local ? [label.local] : []), ...label.remotes.map((r) => r.fullName)];
}

/**
 * The rows "in" the branches `refs` (J22's branch-hover focus): the rows `branchMembership`
 * claimed for any of them, plus their tips. Not all reachable history: a commit a higher-ranked
 * branch claimed (the trunk's, below a merge) isn't in. O(rows).
 */
export function branchRows(membership: readonly (BranchMembership | null)[], labels: Map<number, RefLabel[]>, refs: readonly string[]): Set<number> {
  const wanted = new Set(refs);
  const rows = new Set<number>();
  if (wanted.size === 0) return rows;
  for (const [row, list] of labels) if (list.some((l) => chipRefs(l).some((r) => wanted.has(r)))) rows.add(row);
  membership.forEach((m, i) => { if (m && wanted.has(m.ref)) rows.add(i); });
  return rows;
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
 * Claimant order (`pinnedRefs`: the payload's pinned pair, local first):
 * 0. the trunk's local branch: the pinned local branch; for a remote branch pinned alone, the
 *    local branch named like its branch (`main` for `origin/main`), else that remote branch.
 *    With no trunk (an unpinned repo, or a pinned override that isn't a branch ref), the
 *    checked-out (HEAD) local branch. So `main` keeps its history even when `hotfix`, forked
 *    off main's tip, took main's own lane (unpinned) or is newer than main's unpushed commits;
 * 1. the other pinned branch refs (the pair's remote branch); for a local branch pinned alone,
 *    the remote branches of its name: when local main is behind origin/main, origin/main claims
 *    its own commits before a branch forked off it can;
 * 2. the other local branches, newest tip first;
 * 3. remote branches with no local branch of that name (`origin/topic`), newest tip first;
 * 4. the remaining remote branches (`upstream/main` next to a local `main`): they get only what
 *    nobody else claimed, i.e. their own commits ahead of it.
 *
 * Tags and a detached `HEAD` never claim. Unclaimed rows (a deleted branch's merged side
 * history, stash and WIP rows) get none.
 */
export function branchMembership(rows: RowPayload[], labels: Map<number, RefLabel[]>, pinnedRefs: readonly string[] = []): (BranchMembership | null)[] {
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

  // Rank 0: the trunk's local branch. Rank 1: the other pinned branch refs (a local main BEHIND
  // origin/main must not let another local branch forked off origin/main claim origin/main's
  // own commits). A pinned override that is neither `refs/heads/` nor `refs/remotes/` (e.g. a
  // tag) isn't a branch: it pins nothing here, and HEAD's branch goes first, as with no trunk.
  const pinned = pinnedRefs.filter((r) => r.startsWith('refs/heads/') || REMOTES.test(r));
  const pinnedLocal = pinned.find((r) => r.startsWith('refs/heads/'));
  let trunkRef: string | null = null;
  if (pinnedLocal) trunkRef = pinnedLocal;
  else if (pinned.length) {
    // Its branch part, exact from its label (a remote name may contain `/`), else from the name.
    const branch = remotes.find((r) => r.ref === pinned[0])?.branch ?? pinned[0].replace(/^refs\/remotes\/[^/]+\//, '');
    trunkRef = locals.find((l) => l.name === branch)?.ref ?? pinned[0];
  } else trunkRef = locals.find((l) => l.head)?.ref ?? null;
  const ranked1 = new Set(pinned.filter((r) => r !== trunkRef));
  // A local branch pinned alone (no upstream): the remote branches named like it stand in.
  const localName = pinned.length === 1 && pinnedLocal ? locals.find((l) => l.ref === pinnedLocal)?.name : undefined;
  for (const r of remotes) if (localName !== undefined && r.branch === localName) ranked1.add(r.ref);

  const claimants: Claimant[] = [];
  const add = (tip: number, rank: number, name: string, ref: string) => claimants.push({ tip, rank, membership: { name, color: rows[tip].color, ref } });
  const top = (ref: string) => (ref === trunkRef ? 0 : ranked1.has(ref) ? 1 : -1);
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
