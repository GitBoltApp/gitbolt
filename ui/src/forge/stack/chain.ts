import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { MrState } from '../../api/gen/MrState';
import type { Stack } from '../../stacks/detect';
import { mrRef } from '../labels';

/** A branch's newest MR/PR in the tab's target project, any state (`branchMrs` in `deps.ts`, over 4B's `mrForLabel`). */
export type MrOf = (branch: string) => ForgeMr | null;

/** GitLab's native stacks hold at most 20; a longer walk is a loop (Ruling 13). */
export const MAX_CHAIN = 20;

export const MR_STATE_WORDS: Record<MrState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', merging: 'Merging', closed: 'Closed' };

export const isOpenMr = (m: ForgeMr | null | undefined): m is ForgeMr => !!m && (m.state === 'open' || m.state === 'draft');

export interface MrChain {
  /** Bottom → top. */
  mrs: ForgeMr[];
  /** Where the MR/PR asked about is. */
  index: number;
}

/** What the chain and after-merge predicates read, built once per pass (`stackEnvOf` in `env.ts`). */
export interface StackEnv {
  /** A branch's newest MR/PR (one branch→MR map per pass). */
  mrOf: MrOf;
  /** The local branches. */
  locals: ReadonlySet<string>;
  /** The target project's default branch. */
  defaultBranch: string;
  /** The stack base as a forge branch (`main` for `refs/remotes/origin/main`); null: unknown. */
  base: string | null;
  /** The local stack through a branch (#3's detection). */
  stackOf(branch: string): Stack | null;
  /** A local branch's tip. */
  tipOf(branch: string): string | null;
}

/** The default or the base branch: never a member, never walked through. */
const trunk = (b: string, env: StackEnv) => b === env.defaultBranch || b === env.base;

/**
 * The one "is this a stack edge" test (`mrChain` and `afterMerge`): `above` sits on `below`.
 * - `above` targets `below`'s source branch, in the same target project;
 * - (a) `below`'s source is neither the default branch nor the stack's base;
 * - (b) `below` targets the stack's base, the default branch or another member's branch (`member`);
 * - (c) `below`'s source is a local branch, or (its local branch deleted after the merge) the
 *   branch `above`, an open MR/PR of a member, targets.
 * Shape only: a long-lived branch can fit it (GitFlow's `develop → main`, `develop` at the released
 * head), so a retarget also needs `stacked` evidence (`stackedEdge`); the chain display doesn't.
 */
export function stackEdge(below: ForgeMr, above: ForgeMr, env: StackEnv, member: (b: string) => boolean): boolean {
  if (above.targetBranch !== below.sourceBranch || above.targetProject !== below.targetProject) return false;
  if (trunk(below.sourceBranch, env)) return false;
  if (!trunk(below.targetBranch, env) && !member(below.targetBranch)) return false;
  return env.locals.has(below.sourceBranch) || (isOpenMr(above) && member(above.sourceBranch));
}

/** Stack evidence for the edge: one of the two carries GitBolt's Stack table (`ForgeMr.stacked`). */
export const stackedEdge = (below: ForgeMr, above: ForgeMr): boolean => below.stacked || above.stacked;

/**
 * The stack through `mr` (spec #4 §4 4D: badges and the MR/PR view show the stack; Ruling 13),
 * each step a `stackEdge` (shape only: a display, no action follows it; a long-lived branch can read as a stack, and any retarget still needs `stackedEdge`):
 * - down: the MR/PR of each target branch, merged ones included, until the default or the base
 *   branch; a walk that doesn't end on one (an environment or release branch) isn't a stack;
 * - up: the open MR/PR of a local branch that targets the top's source branch, the newest when
 *   several do.
 * A closed MR in the middle (found through a target) still shows. Same target project only, at most `MAX_CHAIN`, never a branch twice. `null`: just `mr`.
 */
export function mrChain(mr: ForgeMr, env: StackEnv): MrChain | null {
  const seen = new Set([mr.sourceBranch]);
  let down: ForgeMr[] = [];
  let above = mr;
  while (!trunk(above.targetBranch, env) && !seen.has(above.targetBranch) && down.length + 1 < MAX_CHAIN) {
    const below = env.mrOf(above.targetBranch);
    // (b) for a middle one: its target is the next one down, checked on the next turn and below.
    if (!below || !stackEdge(below, above, env, () => true)) break;
    seen.add(below.sourceBranch);
    down.unshift(below);
    above = below;
  }
  // The walk ended off the base: nothing below `mr` is a stack.
  if (down.length && !trunk(down[0].targetBranch, env)) {
    for (const m of down) seen.delete(m.sourceBranch);
    down = [];
  }
  const members = new Set([...down.map((m) => m.sourceBranch), mr.sourceBranch]);
  const up: ForgeMr[] = [];
  let top = mr;
  while (down.length + 1 + up.length < MAX_CHAIN) {
    const next = [...env.locals]
      .filter((b) => !trunk(b, env) && !seen.has(b))
      .map(env.mrOf)
      .filter((m): m is ForgeMr => isOpenMr(m) && m.targetProject === mr.targetProject && stackEdge(top, m, env, (b) => members.has(b)))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!next) break;
    seen.add(next.sourceBranch);
    members.add(next.sourceBranch);
    up.push(next);
    top = next;
  }
  const mrs = [...down, mr, ...up];
  return mrs.length >= 2 ? { mrs, index: down.length } : null;
}

/** The hover card's line: `Stack 2 of 3 (below: !1, above: !3)`. */
export function stackLine(c: MrChain, kind: ForgeKind): string {
  const below = c.mrs[c.index - 1];
  const above = c.mrs[c.index + 1];
  const near = [below ? `below: ${mrRef(kind, below.number)}` : null, above ? `above: ${mrRef(kind, above.number)}` : null].filter((x) => x !== null).join(', ');
  return `Stack ${c.index + 1} of ${c.mrs.length} (${near})`;
}

/** What's left to do after a stack's bottom merged. */
export interface AfterMerge {
  merged: ForgeMr;
  /** The open MR/PR right above it. */
  next: ForgeMr;
  /** Where `next` should point: the merged one's target. */
  target: string;
  /** `next` still targets the merged branch. */
  retarget: boolean;
  /** The local branches to rebase, bottom (`next`'s) → top. */
  branches: string[];
  /** Drop points, best first: the merged MR's head (exactly what merged), then the merged branch's local tip (the forge rewrote it). Rows at or below the first one found are dropped (Ruling 9). */
  dropFrom: string[];
}

/**
 * After the stack `branch` is in had its bottom merged (spec #4 §4 4D, Rulings 8–9), each pair a
 * `stackEdge` (a long-lived branch's merged MR, `main → production` or `develop → main`, is none):
 * - an open member's MR/PR targets a merged MR/PR's source branch: retarget, then rebase what's above.
 *   The retarget is a forge write before any confirm, so it also needs stack evidence (`stackedEdge`);
 * - else the local stack's bottom member's MR/PR merged and the next one's is open (the forge
 *   retargeted it already: GitHub from its UI, GitLab's native stacks): rebase only, confirmed and
 *   undoable, so the shape is enough.
 * `null` when neither. It cannot tell a squash-merged bottom that is still local and already handled
 * (the next MR targets the merged one's target and nothing needs rebasing): T8 must dedupe by `merged.number`.
 */
export function afterMerge(branch: string, env: StackEnv): AfterMerge | null {
  const stack = env.stackOf(branch);
  const members = stack?.branches ?? [branch];
  const member = (b: string) => members.includes(b);
  const make = (merged: ForgeMr, next: ForgeMr, branches: string[]): AfterMerge => ({
    merged, next, target: merged.targetBranch, retarget: next.targetBranch !== merged.targetBranch, branches,
    dropFrom: [...new Set([merged.headSha, env.tipOf(merged.sourceBranch)].filter((x): x is string => !!x))],
  });
  for (let i = 0; i < members.length; i++) {
    const next = env.mrOf(members[i]);
    if (!isOpenMr(next)) continue;
    const merged = env.mrOf(next.targetBranch);
    if (merged?.state === 'merged' && stackedEdge(merged, next) && stackEdge(merged, next, env, member)) return make(merged, next, members.slice(i));
  }
  if (stack && stack.branches.length >= 2) {
    const merged = env.mrOf(stack.branches[0]);
    const next = env.mrOf(stack.branches[1]);
    if (merged?.state !== 'merged' || !isOpenMr(next)) return null;
    // The forge moved `next` onto the merged one's target: test the edge as it was before.
    const before = next.targetBranch === merged.targetBranch ? { ...next, targetBranch: merged.sourceBranch } : next;
    const a = stackEdge(merged, before, env, member) ? make(merged, next, stack.branches.slice(1)) : null;
    return a && (!a.retarget || stackedEdge(merged, next)) ? a : null;
  }
  return null;
}

/** One pass over the local branches: the first after-merge candidate (the prompt), or the one for `mergedNumber`. */
export function firstAfterMerge(env: StackEnv, pick: (a: AfterMerge) => boolean = () => true): AfterMerge | null {
  for (const b of env.locals) {
    const a = afterMerge(b, env);
    if (a && pick(a)) return a;
  }
  return null;
}
