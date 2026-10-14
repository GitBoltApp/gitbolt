// Plain rebase (the core's write/rebase.rs `RebaseIntent` and integrate.rs's lossy-merge check):
// the branch's commits not in the target, replayed onto it (merges remerged, as the core's
// `--rebase-merges`), commits the target already has left out, the stacked branches moved along
// (`--update-refs`). The steps follow the todo git writes for it, as the binary showed it (2.53,
// the Task 5 ledger), so the step counter reads as git's.
import type { Confirm } from '../../../api/gen/Confirm';
import type { Expect } from '../../../api/gen/Expect';
import type { IntegrateOutcome } from '../../../api/gen/IntegrateOutcome';
import type { WriteResult } from '../../../api/gen/WriteResult';
import type { DemoContext } from '../../context';
import { compareBytewise } from '../read/bytes';
import { readCommit } from '../read/commitText';
import { ancestors, configBool, mergeBaseOf, mergeBasesOf, relation, revParse } from '../read/revs';
import { fail, readRepoOf, type ReadRepo } from '../read/seam';
import { worktreeOf } from '../read/worktrees';
import { gitFailure } from '../errors';
import { checkoutTree, mergeTrees, runWrite, watchRefs, writeOrigHead, type WriteCx, type WriteIntent } from '../writeSeam';
import { startSeq, type SeqEnd } from './engine';
import { samePatches } from './patchId';
import { branchesElsewhere, branchSets, isAncestor, rangeCommits, shortOid as short, shortRef, type RangeCommit } from './range';
import { treeOf } from './replay';
import type { Step } from './state';

/** base..tip as `git rev-list` lists it by default: newest committer date first among the commits
 *  whose children are out, ties in the order they were reached. */
async function revListOrder(read: ReadRepo, tip: string, base: string): Promise<RangeCommit[]> {
  const hidden = await ancestors(read, base);
  const out: RangeCommit[] = [];
  const seen = new Set<string>([tip]);
  const queue: { oid: string; time: number; n: number }[] = [];
  let n = 0;
  const push = async (oid: string) => {
    if (!hidden.has(oid)) queue.push({ oid, time: (await readCommit(read, oid)).committer.time, n: n++ });
  };
  await push(tip);
  while (queue.length > 0) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].time > queue[best].time || (queue[i].time === queue[best].time && queue[i].n < queue[best].n)) best = i;
    const { oid } = queue.splice(best, 1)[0];
    const parents = (await readCommit(read, oid)).parents;
    out.push({ oid, parents });
    for (const p of parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      await push(p);
    }
  }
  return out;
}

/** The core's `lossy_among` over tip's range: the first merge (in `rev-list`'s order) whose tree
 *  isn't the clean merge of its two parents (a resolution, a change made in the merge, or a merge
 *  of an unrelated history, which has no merge base to remerge from), as `abc1234 <its first
 *  line>`; an octopus counts too. Null when there's none. */
export async function lossyMerge(read: ReadRepo, tip: string, base: string): Promise<string | null> {
  for (const c of await revListOrder(read, tip, base)) {
    if (c.parents.length < 2) continue;
    const own = await readCommit(read, c.oid);
    let same = false;
    if (c.parents.length === 2) {
      const mb = await mergeBaseOf(read, c.parents[0], c.parents[1]);
      if (mb !== null) {
        const r = await mergeTrees(read, { base: await treeOf(read, mb), ours: await treeOf(read, c.parents[0]), theirs: await treeOf(read, c.parents[1]), labels: { ours: 'ours', theirs: 'theirs', base: 'base' } });
        same = r.tree === own.tree;
      }
    }
    if (!same) return `${short(c.oid)} ${own.rawMessage.split('\n')[0].replace(/\r$/, '')}`;
  }
  return null;
}

/** The refusal for a lossy merge, shared by the rebase and the preview (the core's `lossy_message`). */
export function lossyMessage(branch: string, merge: string, target: string): string {
  return `${branch} has a merge commit with changes of its own (${merge}); a rebase would drop them. Merge ${shortRef(target)} into ${branch} instead`;
}

/** The commits of `range` (tip..onto, topo order) that `onto`'s side already has, by patch id: git
 *  leaves them out of its todo. A commit that started empty never is (git keeps it). */
async function alreadyUpstream(read: ReadRepo, range: RangeCommit[], tip: string, onto: string): Promise<Set<string>> {
  return samePatches(read, range.map((c) => c.oid), (await rangeCommits(read, onto, tip)).map((c) => c.oid), false);
}

/** The steps a rebase of `tip` onto `onto` replays, as git's todo (2.53) lays them out:
 *  - linear: a pick per commit (the ones upstream already has left out), each stacked branch's
 *    `update-ref` after its tip's pick (names in reverse byte order, as git writes them);
 *  - with merges (`--rebase-merges`): `label onto`, then one block per merged-in line (reverse topo
 *    order of their tips) and the branch's own line last, each block a `reset` to its base, the
 *    first-parent walk from its tip down to a commit an earlier block took, and a `label` after any
 *    commit a later `reset` or `merge` names. A block whose base is outside the range starts on
 *    `onto` when that base is a merge base of the two, else on the base itself (git keeps a cousin
 *    line where it was). The `label`/`reset` lines and the merged-in branches' `update-ref` lines
 *    (`mergedIn`: git moves them, the core puts them back) are `line` steps, counted as git's.
 *  `map`: where each parent outside the range goes (the runner's starting map). */
export async function plainSteps(read: ReadRepo, tip: string, onto: string, stacked: [string, string][], mergedIn: [string, string][] = []): Promise<{ steps: Step[]; range: string[]; map: Record<string, string> }> {
  const topo = await rangeCommits(read, tip, onto);
  const dropped = await alreadyUpstream(read, topo, tip, onto);
  const refsAt = new Map<string, Step[]>();
  const moved = new Set(stacked.map(([n]) => n));
  for (const [name, oid] of [...stacked, ...mergedIn].sort(([a], [b]) => compareBytewise(b, a))) {
    refsAt.set(oid, [...(refsAt.get(oid) ?? []), moved.has(name) ? { op: 'updateRef', ref: name } : { op: 'line', text: `update-ref ${name}` }]);
  }
  const range = topo.map((c) => c.oid).reverse();
  const steps: Step[] = [];
  const map: Record<string, string> = {};
  if (!topo.some((c) => c.parents.length > 1)) {
    for (const oid of range) {
      if (dropped.has(oid)) continue;
      steps.push({ op: 'pick', oid, parent: null }, ...(refsAt.get(oid) ?? []));
    }
    return { steps, range, map };
  }

  const parents = new Map(topo.map((c) => [c.oid, c.parents]));
  // A left-out commit's children go where it would have.
  const eff = (p: string): string => {
    let at = p;
    while (dropped.has(at)) at = parents.get(at)![0];
    return at;
  };
  const bases = new Set(await mergeBasesOf(read, tip, onto));
  const outside = (p: string) => {
    if (!parents.has(p) && map[p] === undefined) map[p] = bases.has(p) ? onto : p;
  };
  const firstParentOf = new Set(topo.map((c) => c.parents[0]).filter((p) => p !== undefined && parents.has(p)));
  const tips = range.filter((oid) => oid !== tip && !firstParentOf.has(oid));
  const blocks: { chain: string[]; base: string | undefined }[] = [];
  const taken = new Set<string>();
  for (const t of [...tips, tip]) {
    const chain: string[] = [];
    let at: string | undefined = t;
    while (at !== undefined && parents.has(at) && !taken.has(at)) {
      taken.add(at);
      chain.push(at);
      at = parents.get(at)![0];
    }
    blocks.push({ chain: chain.reverse(), base: at === undefined ? undefined : eff(at) });
  }
  const named = new Set<string>();
  for (const b of blocks) if (b.base !== undefined && parents.has(b.base)) named.add(b.base);
  for (const c of topo) for (const p of c.parents.slice(1)) if (parents.has(eff(p))) named.add(eff(p));
  steps.push({ op: 'line', text: 'label onto' });
  for (const [i, b] of blocks.entries()) {
    if (b.base !== undefined) outside(b.base);
    const from = b.base === undefined ? 'onto' : parents.has(b.base) ? short(b.base) : map[b.base] === onto ? 'onto' : short(b.base);
    steps.push({ op: 'line', text: `reset ${from}` });
    for (const oid of b.chain) {
      if (dropped.has(oid)) continue;
      const ps = parents.get(oid)!.map(eff);
      ps.forEach(outside);
      steps.push(ps.length > 1 ? { op: 'merge', oid, parents: ps } : { op: 'pick', oid, parent: ps[0] ?? null }, ...(refsAt.get(oid) ?? []));
      if (named.has(oid)) steps.push({ op: 'line', text: `label ${short(oid)}` });
    }
    // A merged-in line the target already has whole still gets its label (git's todo), which
    // names where its first commit would have gone.
    const last = b.chain.at(-1);
    if (i < blocks.length - 1 && last !== undefined && dropped.has(last)) steps.push({ op: 'line', text: `label ${short(last)}` });
  }
  return { steps, range, map };
}

/** A rebase's stop as its outcome. UX F: a stop with no conflict is a step git refused: its
 *  message goes with the stop, as the core's warning. */
export function stoppedOutcome(end: Extract<SeqEnd, { status: 'stopped' }>): IntegrateOutcome {
  const said = end.files === 0 && end.stop.error ? end.stop.error.trim().replace(/\.+$/, '') : null;
  return { status: 'stopped', kind: 'rebase', files: end.files, ...(said !== null ? { warning: `The rebase stopped: ${said}` } : {}) };
}

const throwGit = (message: string): never => {
  throw gitFailure(message, `fatal: ${message}\n`);
};

export function rebaseIntent(o: { target: string; updateRefs?: boolean; confirm: Confirm; seen?: string }): WriteIntent<IntegrateOutcome> {
  let branch = o.seen ?? 'HEAD';
  let onto = '';
  let updateRefsConfig: boolean | undefined;
  return {
    kind: 'rebase',
    label: () => `rebase ${branch} onto ${shortRef(o.target)}`,
    undo: 'rewind',
    confirm: o.confirm,
    rewrite: () => 'rebase',
    async plan(pre) {
      branch = pre.before.head.branch ?? fail('InvalidInput', 'Check out a branch to rebase it');
      onto = await revParse(pre.read, o.target, pre.root);
      const head = pre.before.head.oid;
      const lossy = head === null ? null : await lossyMerge(pre.read, head, onto);
      if (lossy) fail('InvalidInput', lossyMessage(branch, lossy, o.target));
      updateRefsConfig = await configBool(pre.read, 'rebase.updateRefs');
      return { autostash: { rule: { kind: 'rebased' }, target: onto, op: `rebase onto ${o.target}`, targetName: o.target } };
    },
    async run(cx: WriteCx): Promise<IntegrateOutcome> {
      // An unborn branch: git refuses (exit 128), and the core passes its words on.
      const head = cx.before.head.oid ?? throwGit('Could not resolve HEAD to a commit');
      const full = `refs/heads/${branch}`;
      if (await isAncestor(cx.read, onto, head)) return { status: 'upToDate' };
      if (await isAncestor(cx.read, head, onto)) {
        const [, behind] = await relation(cx.read, head, onto);
        await checkoutTree(cx, await treeOf(cx.read, head), await treeOf(cx.read, onto));
        // git sets ORIG_HEAD as it starts (HEAD's reflog isn't kept in the demo, as phase 3's).
        writeOrigHead(cx, head);
        await cx.cas([{ name: full, old: head, new: onto }], `rebase (finish): ${full} onto ${onto}`);
        return { status: 'done', commits: behind, fastForward: true };
      }
      // The core's: the request's choice, else `rebase.updateRefs`, else none; and the flag only
      // when a stacked branch is there to move (git's own `--update-refs` would move the merged-in
      // ones too). A branch checked out in any worktree is never moved (git's comment line).
      let stacked: [string, string][] = [];
      let mergedIn: [string, string][] = [];
      if (o.updateRefs ?? updateRefsConfig ?? false) {
        const away = await branchesElsewhere(cx.read, cx.root);
        const sets = await branchSets(cx.read, full, head, onto);
        stacked = sets.stacked.filter(([n]) => !away.has(n));
        mergedIn = stacked.length === 0 ? [] : sets.mergedIn.filter(([n]) => !away.has(n));
      }
      watchRefs(cx, stacked);
      const { steps, range, map } = await plainSteps(cx.read, head, onto, stacked, mergedIn);
      const end = await startSeq(cx, {
        kind: 'rebase', headName: full, origHead: head, onto, target: o.target, interactive: false, steps, range, map,
        refsBefore: Object.fromEntries(stacked), deletes: {}, empty: 'drop',
      });
      if (end.status === 'stopped') {
        cx.paused = { kind: 'rebase', target: o.target, targetOid: onto, picked: [], irebase: false };
        return stoppedOutcome(end);
      }
      const warning = end.warning ? { warning: end.warning } : {};
      if (end.head === head) return { status: 'upToDate', ...warning };
      const [commits] = await relation(cx.read, end.head, onto);
      return { status: 'done', commits, fastForward: false, ...warning };
    },
  };
}

export async function rebaseIntegrate(ctx: DemoContext, p: { repo: number; worktree: string; target: string; updateRefs?: boolean; expect: Expect; confirm: Confirm }): Promise<WriteResult<IntegrateOutcome>> {
  // For the queue's label only: the branch settles in `plan`, under the lock.
  let seen: string | undefined;
  try {
    seen = shortRef((await worktreeOf(readRepoOf(ctx, p.repo), p.worktree)).branch ?? 'HEAD');
  } catch {
    // runWrite refuses an unknown worktree itself.
  }
  return runWrite(ctx, p.repo, p.worktree, p.expect, rebaseIntent({ target: p.target, updateRefs: p.updateRefs, confirm: p.confirm, seen }));
}
