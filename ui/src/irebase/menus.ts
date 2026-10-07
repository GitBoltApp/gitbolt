import { Combine, ListOrdered } from 'lucide-react';
import { useRuntime } from '../app/runtime';
import { tabStore } from '../app/tabStores';
import type { CommitTarget, MenuEnv, SelectionTarget } from '../menu/menuEnv';
import type { MenuRow } from '../menu/types';
import { useToast } from '../ui/toastStore';
import { writeCtx } from '../write/ctx';
import { openRebaseEditor } from './open';
import { squashSelection } from './squash';

/*
 * The interactive rebase's entry points (spec #3 §4.3). Impossible rows are hidden, busy ones
 * greyed with 2D's Integrate reason:
 * - While an operation is in progress, rows show greyed with "Finish or abort the <op> first",
 *   on a detached HEAD too (a rebase detaches it). Otherwise every row is hidden on a detached
 *   HEAD: an interactive rebase rewrites HEAD's branch, and there is none.
 * - Onto Y: hidden on WIP and stash rows, when Y is HEAD's branch or at HEAD, and when HEAD is
 *   already in Y's history (nothing to rebase).
 * - After this commit: hidden at HEAD and for commits known not to be in HEAD's branch.
 * - The selection's from here: from its oldest commit's parent.
 * - Selection rows: hidden unless every selected commit is a non-merge commit not known to be
 *   outside HEAD's branch, and the oldest has exactly one parent.
 */

const short = (oid: string) => oid.slice(0, 7);
const busyReason = (op: string | null) => (op ? `Finish or abort the ${op} first` : undefined);
const busy = (env: MenuEnv) => busyReason(env.inProgress);
/** HEAD's branch, `HEAD` when detached during an operation (its greyed rows), null: hide the rows. */
const headName = (env: MenuEnv) => env.headBranch ?? (env.inProgress ? 'HEAD' : null);

/** A commit's loaded graph row (its parents), from the tab's store: menus stay synchronous. */
function rowOf(env: MenuEnv, sha: string): { parents: string[] } | undefined {
  const s = env.write ? tabStore(env.write.tabId)?.getState() : undefined;
  const i = s?.indexById.get(sha);
  return i === undefined ? undefined : s!.graph.rows[i];
}

/** The branch chip menu's "Interactive rebase X onto Y", in the Integrate group. */
export function ontoRows(t: CommitTarget, env: MenuEnv): MenuRow[] {
  const x = headName(env);
  const y = t.branch;
  if (!x || !y || !env.write || t.isWip || t.isStash || y.name === x || t.sha === env.headSha) return [];
  if (env.headSha && env.isAncestor?.(env.headSha, t.sha) === true) return []; // HEAD is in Y's history: nothing to rebase
  const target = y.local ? y.name : y.remotes[0]?.fullName.replace(/^refs\/remotes\//, '') ?? y.name;
  const tabId = env.write.tabId;
  return [{
    kind: 'action', id: 'irebase.onto', label: `Interactive rebase ${x} onto ${target}`, icon: ListOrdered,
    tooltip: `Reorder, reword, squash or drop ${x}'s commits, then put them on ${target}`, disabledReason: busy(env),
    run: () => { if (env.headBranch) void openRebaseEditor(tabId, { branch: env.headBranch, base: target }); },
  }];
}

/** "Interactive rebase after this commit" (UX4 Q.5): the clicked commit is the
 * base, its descendants on HEAD's branch the rows. Hidden at HEAD (nothing to rebase) and off
 * HEAD's history; a merge or a root is a base like any other. */
export function fromHereRows(t: CommitTarget, env: MenuEnv): MenuRow[] {
  const x = headName(env);
  if (!env.write || t.isWip || t.isStash || !x || !env.headSha) return [];
  if (t.sha === env.headSha || env.isAncestor?.(t.sha, env.headSha) === false) return [];
  const [tabId, base] = [env.write.tabId, t.sha];
  return [{
    kind: 'action', id: 'irebase.fromHere', label: 'Interactive rebase after this commit', icon: ListOrdered,
    tooltip: `Edit ${x}'s commits after ${short(t.sha)}`, disabledReason: busy(env),
    run: () => { if (env.headBranch) void openRebaseEditor(tabId, { branch: env.headBranch, base }); },
  }];
}

/** A selection a squash or rebase can start from: on HEAD's branch, no merge, the oldest not a root. */
function fromOldest(t: SelectionTarget, env: MenuEnv): { tabId: string; branch: string; base: string; oids: string[] } | null {
  const head = env.headSha;
  const branch = headName(env);
  if (!env.write || !branch || !head || t.commits.length < 2) return null;
  if (t.commits.some((c) => c.merge || env.isAncestor?.(c.oid, head) === false)) return null;
  const row = rowOf(env, t.commits[t.commits.length - 1].oid);
  if (!row || row.parents.length !== 1) return null;
  return { tabId: env.write.tabId, branch, base: row.parents[0], oids: t.commits.map((c) => c.oid) };
}

/** The selection's two plain rows: "Squash N commits" and "Squash N commits interactively…" (the editor, preset the same way). */
export function squashRows(t: SelectionTarget, env: MenuEnv): MenuRow[] {
  const s = fromOldest(t, env);
  if (!s) return [];
  const into = short(s.oids[s.oids.length - 1]);
  const n = s.oids.length;
  const run = (interactive: boolean) => () => { if (env.headBranch) void squashSelection(s.tabId, s.branch, s.oids, s.base, interactive); };
  return [
    {
      kind: 'action', id: 'irebase.squash', label: `Squash ${n} commits`, icon: Combine,
      tooltip: `Squash the ${n} commits into ${into}, their messages merged`, disabledReason: busy(env), run: run(false),
    },
    {
      kind: 'action', id: 'irebase.squashInteractive', label: `Squash ${n} commits interactively…`, icon: ListOrdered,
      tooltip: 'Open the interactive rebase with them set to squash', disabledReason: busy(env), run: run(true),
    },
  ];
}

/** The selection's "Interactive rebase from here": from its oldest commit up. */
export function selectionFromHereRows(t: SelectionTarget, env: MenuEnv): MenuRow[] {
  const s = fromOldest(t, env);
  if (!s) return [];
  return [{
    kind: 'action', id: 'irebase.selectionFromHere', label: 'Interactive rebase from here', icon: ListOrdered,
    tooltip: `Edit ${s.branch}'s commits from ${short(s.oids[s.oids.length - 1])} up`, disabledReason: busy(env),
    run: () => { if (env.headBranch) void openRebaseEditor(s.tabId, { branch: s.branch, base: s.base }); },
  }];
}

/** HEAD's branch in tab `tabId` and its upstream (`origin/main`; null: none, or gone). Null on a detached HEAD. */
export function headOf(tabId: string): { branch: string; upstream: string | null } | null {
  const branch = tabStore(tabId)?.getState().graph.head.branch?.replace(/^refs\/heads\//, '') ?? null;
  if (!branch) return null;
  const local = useRuntime.getState().tabs[tabId]?.sidebar?.locals.find((b) => b.name === branch);
  return { branch, upstream: local?.upstream && !local.gone ? local.upstream.replace(/^refs\/remotes\//, '') : null };
}

/** The operation in progress in tab `tabId`'s active worktree (`merge`, `rebase`…), or null. */
export function opOf(tabId: string): string | null {
  const wt = writeCtx(tabId)?.worktree;
  return tabStore(tabId)?.getState().graph.worktrees.find((w) => w.path === wt)?.inProgress ?? null;
}

/** Whether the palette offers "Interactive rebase…": HEAD on a branch, or an operation to finish. */
export const paletteUsable = (tabId: string): boolean => !!headOf(tabId) || !!opOf(tabId);

/** The palette's "Interactive rebase…" (Ruling 12): HEAD's branch onto its upstream; with none,
 * a toast says where to start it. During an operation, a toast says to finish it first. */
export function paletteRebase(tabId: string): void {
  const op = opOf(tabId);
  if (op) return void useToast.getState().show(busyReason(op)!);
  const h = headOf(tabId);
  if (!h) return;
  if (!h.upstream) return void useToast.getState().show(`${h.branch} has no upstream: open "Interactive rebase ${h.branch} onto …" from a branch's menu`);
  void openRebaseEditor(tabId, { branch: h.branch, base: h.upstream });
}
