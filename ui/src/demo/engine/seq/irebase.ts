// The interactive rebase and the reword of an older commit (the core's write/irebase/run.rs
// `IrebaseIntent`, reword.rs `reword_commit`): the plan's range read again under the lock, the
// request checked against it, the todo built, the sequencer started. The pause carries the
// session (the commits made at its stops, the refs its Continue moves), and the chips marked
// delete go once it completes, in the same journal entry.
import type { ChipPlan } from '../../../api/gen/ChipPlan';
import type { Confirm } from '../../../api/gen/Confirm';
import type { Expect } from '../../../api/gen/Expect';
import type { IntegrateOutcome } from '../../../api/gen/IntegrateOutcome';
import type { RebaseRow } from '../../../api/gen/RebaseRow';
import type { WriteResult } from '../../../api/gen/WriteResult';
import type { DemoContext } from '../../context';
import { trimRust } from '../objects';
import { gitSubject, readCommit } from '../read/commitText';
import { refsUnder, relation } from '../read/revs';
import { demoOf, fail, readRepoOf } from '../read/seam';
import { worktreeOf } from '../read/worktrees';
import { refMoved, runWrite, watchRefs, type WriteCx, type WriteIntent } from '../writeSeam';
import { startSeq } from './engine';
import { MAX_ROWS, readRange, type Range } from './plan';
import { isAncestor, shortRef } from './range';
import { stoppedOutcome } from './rebase';
import { buildTodo, type Todo } from './todo';

type Source = { kind: 'plan'; rows: RebaseRow[]; chips: ChipPlan[] } | { kind: 'reword'; oid: string; message: string };
const invalid = (m: string): never => fail('InvalidInput', m);

/** The core's `check_expect`: the refs the plan was made against (the branch, every chip's, the
 *  base's own unpeeled value), each in the request's `expect` with its value now. */
function checkExpect(branch: string, range: Range, expect: Expect): void {
  const need: [string, string | null][] = [[`refs/heads/${branch}`, range.head], ...range.chips.map((c): [string, string | null] => [`refs/heads/${c.branch}`, range.tips.get(c.branch) ?? null])];
  if (range.baseRef !== null && range.baseRefTarget !== null) need.push([range.baseRef, range.baseRefTarget]);
  for (const [name, now] of need) {
    if (!(name in expect.refs)) invalid(`The plan doesn't say where ${shortRef(name)} was: reload it`);
    if (expect.refs[name] !== now) throw refMoved(name);
  }
}

/** The core's `check_chips`: every chip of the range is there, and only the range's chips move or go. */
function checkChips(branch: string, range: Range, chips: ChipPlan[]): void {
  const ours = new Set(range.chips.map((c) => c.branch));
  for (const c of chips) if (c.branch !== branch && c.at.kind !== 'new' && !ours.has(c.branch)) invalid(`${c.branch} isn't one of ${branch}'s branches: reload the plan`);
  const sent = new Set(chips.map((c) => c.branch));
  const missing = range.chips.find((c) => !sent.has(c.branch));
  if (missing) invalid(`The plan doesn't match ${branch}'s branches any more (${missing.branch} is missing): reload it`);
}

/** The core's reword.rs `rows_for`: every row Pick but that one, every chip on its own row. */
function rowsFor(range: Range, branch: string, oid: string, message: string): { rows: RebaseRow[]; chips: ChipPlan[] } {
  if (!range.rows.some((r) => r.oid === oid)) invalid(`That commit isn't in ${branch}'s history any more`);
  if (range.merges > 0) invalid(`This would flatten ${range.merges} merge commit${range.merges === 1 ? '' : 's'}: use the interactive rebase editor`);
  const locked = range.chips.find((c) => c.locked !== null);
  if (locked) invalid(`${locked.branch} can't move with the reword: ${locked.locked}`);
  return {
    rows: range.rows.map((r): RebaseRow => (r.oid === oid ? { oid: r.oid, action: 'reword', message } : { oid: r.oid, action: 'pick' })),
    chips: range.chips.map((c): ChipPlan => ({ branch: c.branch, at: { kind: 'row', oid: c.at } })),
  };
}

export function irebaseIntent(o: { branch: string; base: string; source: Source; confirm: Confirm; label: string }): WriteIntent<IntegrateOutcome> {
  let planned: { range: Range; todo: Todo; depth: number | null } | null = null;
  return {
    kind: 'rebase',
    label: () => o.label,
    undo: 'rewind',
    confirm: o.confirm,
    // The core's: recorded only when it completes (a paused write records nothing; settle does).
    rewrite: () => 'rebase',
    async plan(pre) {
      if (pre.before.head.branch !== o.branch) invalid(`Check out ${o.branch} to rebase it`);
      const range = await readRange(pre.read, pre.root, o.branch, o.base, MAX_ROWS);
      let rows: RebaseRow[];
      let chips: ChipPlan[];
      if (o.source.kind === 'plan') {
        checkExpect(o.branch, range, pre.expect);
        const want = new Set(range.rows.map((r) => r.oid));
        const got = new Set(o.source.rows.map((r) => r.oid));
        if (o.source.rows.length !== range.rows.length || got.size !== want.size || [...got].some((x) => !want.has(x))) invalid(`The plan doesn't match ${o.branch}'s commits any more: reload it`);
        checkChips(o.branch, range, o.source.chips);
        ({ rows, chips } = o.source);
      } else {
        // The rows and chips are the range's own, read under the lock: preflight's HEAD check is
        // what the request vouches for.
        ({ rows, chips } = rowsFor(range, o.branch, o.source.oid, o.source.message));
      }
      const by = new Map(range.rows.map((r) => [r.oid, r]));
      const todo = buildTodo({
        branch: o.branch, base: range.base, chips, tips: range.tips, locked: range.locked,
        rows: rows.map((r) => {
          const c = by.get(r.oid)!;
          return { oid: r.oid, action: r.action, original: c.message, guard: `${c.authorEmail} ${c.authorTime} ${gitSubject(c.message)}`, ...(r.message !== undefined ? { message: r.message } : {}) };
        }),
      });
      // A reword's range has no merges: the reworded commit is HEAD's first-parent ancestor this many back.
      const reworded = o.source.kind === 'reword' ? o.source.oid : null;
      planned = { range, todo, depth: reworded === null ? null : range.rows.findIndex((r) => r.oid === reworded) };
      const shown = shortRef(o.base);
      return { autostash: { rule: { kind: 'rebased' }, target: range.base, op: `rebase onto ${shown}`, targetName: shown } };
    },
    async run(cx: WriteCx): Promise<IntegrateOutcome> {
      const { range, todo, depth } = planned!;
      const watch = todo.updateRefs.map((b): [string, string | null] => [`refs/heads/${b}`, range.tips.get(b) ?? null]);
      const deletes = todo.deletes.map((b): [string, string] => [`refs/heads/${b}`, range.tips.get(b)!]);
      // Verify records exactly these besides HEAD's branch: the moved and created chips, the deleted ones.
      watchRefs(cx, [...watch, ...deletes]);
      const end = await startSeq(cx, {
        kind: 'rebase', headName: `refs/heads/${o.branch}`, origHead: range.head, onto: range.base, target: shortRef(o.base), interactive: true,
        steps: todo.steps, range: range.rows.map((r) => r.oid).reverse(), refsBefore: Object.fromEntries(watch), deletes: Object.fromEntries(deletes), empty: 'drop',
      });
      if (end.status === 'stopped') {
        // The pause carries the session: what Commit at a stop makes, what Continue moves.
        cx.paused = { kind: 'rebase', target: shortRef(o.base), targetOid: range.base, picked: [], irebase: true };
        return stoppedOutcome(end);
      }
      const warning = end.warning ? { warning: end.warning } : {};
      if (end.head === range.head) return { status: 'upToDate', ...warning };
      const [commits] = await relation(cx.read, end.head, range.base);
      let rewritten: string | null = null;
      if (depth !== null && depth >= 0) {
        rewritten = end.head;
        for (let i = 0; i < depth && rewritten !== null; i++) rewritten = (await readCommit(cx.read, rewritten)).parents[0] ?? null;
      }
      return { status: 'done', commits, fastForward: false, ...warning, ...(rewritten !== null ? { rewritten } : {}) };
    },
  };
}

/** The core's `trunk`: origin/HEAD's target when it's set, otherwise a local or remote `main` or
 *  `master`; its short name, its local name (`origin/main` → `main`) and its tip. */
async function trunk(ctx: DemoContext, repo: number): Promise<{ name: string; local: string; tip: string } | null> {
  const read = readRepoOf(ctx, repo);
  const all = [...(await refsUnder(read, 'refs/heads')), ...(await refsUnder(read, 'refs/remotes'))];
  const named = (full: string) => {
    const r = all.find((x) => x.name === full);
    if (!r) return null;
    const local = full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : full.replace(/^refs\/remotes\/[^/]+\//, '');
    return { name: shortRef(full), local, tip: r.oid };
  };
  const originHead = demoOf(read).refMap().get('refs/remotes/origin/HEAD')?.symref ?? null;
  return (originHead !== null ? named(originHead) : null) ?? ['refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master'].map(named).find((x) => x !== null) ?? null;
}

/** The core's `reword_commit`: "Edit message" on an older commit of HEAD's branch, a background
 *  interactive rebase from its parent, every row Pick but that one. */
export async function rewordCommit(ctx: DemoContext, p: { repo: number; worktree: string; oid: string; message: string; expect: Expect; confirm: Confirm }): Promise<WriteResult<IntegrateOutcome>> {
  const summary = trimRust((p.message.split('\n')[0] ?? '').replace(/\r$/, ''));
  if (summary === '') invalid('Write a commit summary');
  const read = readRepoOf(ctx, p.repo);
  const here = await worktreeOf(read, p.worktree);
  // For the label and the range only: `plan` checks it's still HEAD's branch, under the lock.
  const commit = /^[0-9a-f]{40}$/.test(p.oid) ? await readCommit(read, p.oid).catch(() => null) : null;
  // R2: a root commit has no parent to rebase from.
  if (commit !== null && commit.parents.length === 0) invalid("The first commit can't be reworded here. Use Interactive rebase.");
  const branch = here.branch?.replace(/^refs\/heads\//, '') ?? invalid('Check out a branch to reword its commits');
  // A commit the trunk has too, reworded from another branch, would be copied into it as divergent history.
  const t = commit === null ? null : await trunk(ctx, p.repo);
  if (t !== null && t.local !== branch && here.head !== null && (await isAncestor(read, p.oid, here.head)) && (await isAncestor(read, p.oid, t.tip))) {
    invalid(`That commit is on ${t.name} too. Rewording it here would copy ${t.name}'s history into this branch.`);
  }
  return runWrite(ctx, p.repo, p.worktree, p.expect, irebaseIntent({ branch, base: `${p.oid}^`, source: { kind: 'reword', oid: p.oid, message: p.message }, confirm: p.confirm, label: `reword "${summary}"` }));
}
