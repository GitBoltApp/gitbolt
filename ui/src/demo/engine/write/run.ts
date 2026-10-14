// Every demo write goes through `runWrite`: the core's `run_write` (write/mod.rs) as the demo needs
// it. 1 queue and lock, 2 preflight, 3 plan and the journal entry written ahead, 4 snapshot, 5
// autostash, 6 run, 7 verify, the staging log, 8 the autostash's restore, 9 finalize, 10 events and
// the fresh lists; 2b and 7b settle a paused merge. No hooks and no network: nothing outside the
// page can touch the demo's repositories. A Cancel takes a waiting write out of the queue; a running
// one sees it through its op (`ctx.writes.cancelled`, `onCancel`).
import type { ChangeKind } from '../../../api/gen/ChangeKind';
import type { Confirm } from '../../../api/gen/Confirm';
import type { Expect } from '../../../api/gen/Expect';
import type { GbError } from '../../../api/gen/GbError';
import type { JournalState } from '../../../api/gen/JournalState';
import type { OpKind } from '../../../api/gen/OpKind';
import type { PausedKind } from '../../../api/gen/PausedKind';
import type { RewriteKind } from '../../../api/gen/RewriteKind';
import type { WipListsPayload } from '../../../api/gen/WipListsPayload';
import type { WriteResult } from '../../../api/gen/WriteResult';
import type { DemoContext } from '../../context';
import { recordCommand } from '../../log';
import { asGbError, gbError } from '../errors';
import { keepPaused, planAutostash, restoreAutostash, saveAutostash, settleAutostash, type AutostashPlan, type AutostashSpec, type Stashed } from './autostash';
import { compareBytewise } from '../read/bytes';
import { readCommit } from '../read/commitText';
import { diffTrees, listFiles } from '../read/trees';
import type { ConfigChange } from './config';
import { inProgressName, type OpName } from './inProgress';
import { sameHead, type IrebasePause, type Journal, type JournalEntry, type PausedOp, type StashMove, type UndoKind } from './journal';
import { demoIdent } from './objects';
import { casRefs, readHead, readRef, refMoved, type HeadState, type RefMove } from './refs';
import { writeTarget, type WriteWt } from './seam';
import { settlePaused } from './settle';
import { createSnapshot, sameSnapshot, type Snapshot } from './snapshot';
import { captureIndex, sameCapture, stagingStateOf, type IndexCapture, type StagingLog } from './staging';
import { wipLists } from './wipLists';

export type WriteClass = 'queued' | 'immediate';
/** How a write touches the staging undo log (§7.6): one step; leaves it; moves steps itself; clears it. */
export type StagingEffect = 'step' | 'keep' | 'own' | 'clear';

/** What a write needs before it runs, from its read-only `plan`. */
export interface Plan {
  /** Snapshot these first (§5.2): the paths, and the untracked ones the write deletes. */
  snapshot?: { paths: string[]; untracked: string[] };
  /** §6.1: autostash on overlap with what the worktree moves to. */
  autostash?: AutostashSpec;
}

/** What preflight read. */
export interface Before {
  head: HeadState;
  /** `expect`'s refs, the intent's `refs()` and HEAD's branch, as they are now. */
  refs: Map<string, string | null>;
  inProgress: OpName | null;
}

export interface Pre {
  ctx: DemoContext;
  wt: WriteWt;
  expect: Expect;
  before: Before;
}

/** A merge, rebase or pick stopped on conflicts: its entry waits (§13.2). */
export interface Pause {
  kind: PausedKind;
  /** What it integrates, as the user named it. */
  target: string;
  targetOid: string | null;
  picked: string[];
  /** An interactive rebase's session (its Abort keeps the work done at a stop). */
  irebase: IrebasePause | null;
}

export interface WriteIntent<O> {
  kind: OpKind;
  /** The journal and Activity label; read again after `plan`, which may settle it. */
  label(): string;
  /** Default `queued`. */
  class?: WriteClass;
  /** How it's undone; null: not journaled. */
  undo(): UndoKind | null;
  allowedInProgress?: boolean;
  /** It does nothing but settle a paused merge (`settlePaused`). */
  onlySettles?: boolean;
  /** Refs it may move besides HEAD's branch (verify compares them). */
  refs?(): string[];
  /** What the user already confirmed (the clean-restore warning). */
  confirm?: Confirm;
  /** Default `clear`. */
  staging?: StagingEffect;
  /** A save of the same file just below takes this one's `after` (UX G.2). */
  coalesces?: boolean;
  /** What it rewrote when it succeeds without pausing (an amend, a rebase): the rewrite marks. */
  rewrite?(): RewriteKind | null;
  /** A transfer made first (the core's `transfer_first`, a pull's fetch): after the queue slot,
   *  before the lock and preflight, so never with an autostash or snapshot out and outside the
   *  journal entry. A throw ends the write there, unjournaled. */
  transferFirst?(ctx: DemoContext, op: number, repo: number): Promise<void>;
  plan?(pre: Pre): Promise<Plan>;
  run(cx: WriteCx): Promise<O>;
}

/** The write lock as a running write holds it: `network` lets it go around a transfer and takes
 *  it again (`WriteCx::unlock` / `relock`); `done` gives it back for good. */
export class HeldLock {
  private readonly take: () => Promise<() => void>;
  private release: (() => void) | null;
  constructor(take: () => Promise<() => void>, release: () => void) {
    this.take = take;
    this.release = release;
  }
  unlock(): void {
    this.release?.();
    this.release = null;
  }
  async relock(): Promise<void> {
    if (this.release === null) this.release = await this.take();
  }
  done(): void {
    this.unlock();
  }
}

/** What an intent's `run` works with. */
export class WriteCx {
  readonly ctx: DemoContext;
  readonly wt: WriteWt;
  readonly expect: Expect;
  readonly before: Before;
  readonly op: number;
  readonly repoId: number;
  /** The plan's `before` snapshot: a destructive intent deletes only what it holds. */
  snapshot: Snapshot | null = null;
  /** The `after` snapshot (discards), kept only when the run succeeds. */
  after: Snapshot | null = null;
  /** The worktree may have changed before a failure: the entry is kept then. */
  partial = false;
  /** An out-of-order undo independent of every redo entry leaves Redo as it is. */
  keepRedo = false;
  journalChanged = false;
  paused: Pause | null = null;
  /** This write's journal entry, once written ahead. */
  entryId: number | null = null;
  readonly kinds = new Set<ChangeKind>();
  /** Refs the run CAS-moved, with the value they had before. */
  readonly touched = new Map<string, string | null>();
  /** Step 5 put the worktree's changes in an autostash (it comes back in step 8). */
  autostashed = false;
  private readonly lock: HeldLock | null;

  constructor(o: { ctx: DemoContext; wt: WriteWt; expect: Expect; before: Before; op: number; repoId: number; lock?: HeldLock }) {
    this.ctx = o.ctx;
    this.wt = o.wt;
    this.expect = o.expect;
    this.before = o.before;
    this.op = o.op;
    this.repoId = o.repoId;
    this.lock = o.lock ?? null;
  }

  /** One transfer outside the write lock (`WriteCx::network`: a push, a remote delete): `f` runs
   *  with the lock released, so immediate writes (stage, discards) go on meanwhile; the lock is
   *  taken again before it returns, whatever `f` did. Only the queue's running slot is held. */
  async network<T>(f: () => Promise<T>): Promise<T> {
    // Never with an autostash out or a snapshot taken: stage and discards would then run against
    // the stashed worktree (the core's debug_assert).
    if (this.autostashed || this.snapshot !== null) throw gbError('Other', 'a write released its lock with an autostash or snapshot active');
    this.lock?.unlock();
    try {
      return await f();
    } finally {
      await this.lock?.relock();
    }
  }

  /** A done Barrier under this write's entry: the run made a push (`WriteCx::barrier_below`). */
  barrierBelow(label: string, kind: OpKind): void {
    if (this.entryId === null) return;
    this.journal.barrierBefore(this.entryId, label, kind, this.before.head, this.ctx.clock.nowMs());
    this.journalChanged = true;
  }

  get journal(): Journal {
    return this.ctx.writes.journal(this.wt.root);
  }

  touch(k: ChangeKind): void {
    this.kinds.add(k);
  }

  /** A ref CAS (§4); verify records what really moved. */
  cas(moves: RefMove[]): void {
    for (const m of moves) if (!this.touched.has(m.name)) this.touched.set(m.name, m.old);
    casRefs(this.wt.demo, moves);
  }

  entry(): JournalEntry | null {
    return this.entryId === null ? null : this.journal.entry(this.entryId);
  }

  editEntry(f: (e: JournalEntry) => void): void {
    const e = this.entry();
    if (e) f(e);
  }

  /** The run found the operation is another kind (a checkout that moved the branch in place: Rewind). */
  setUndo(undo: UndoKind): void {
    this.editEntry((e) => {
      e.undo = undo;
    });
  }

  /** `branch.<name>.*` keys the run changed: undo and redo replay them. */
  recordConfig(changes: ConfigChange[]): void {
    if (changes.length === 0) return;
    this.partial = true;
    this.touch('config');
    this.editEntry((e) => e.config.push(...changes));
  }

  /** A stash the run created or dropped. */
  recordStash(m: StashMove): void {
    this.partial = true;
    this.touch('stash');
    this.editEntry((e) => e.stashes.push(m));
  }

  setNote(note: string): void {
    this.editEntry((e) => {
      e.note = note;
    });
  }

  /** The visitor, now. */
  ident(): string {
    return demoIdent(this.ctx.clock);
  }

  /** The git command this step stands for, for the Debug panel's command log. */
  command(...args: string[]): void {
    recordCommand(args, this.wt.root, 0);
  }
}

/** An `expect` that checks nothing. */
export const NO_EXPECT: Expect = { head: null, refs: {} };

/** `ChangeKind`'s declaration order (the core's `BTreeSet<ChangeKind>`). */
export const KIND_ORDER: ChangeKind[] = ['worktree', 'index', 'refs', 'head', 'stash', 'config', 'state'];

/** §3.2 step 2. */
function preflight(wt: WriteWt, expect: Expect, extra: string[], allowedInProgress: boolean): Before {
  const inProgress = inProgressName(wt.fs, wt.gitdir);
  if (inProgress !== null && !allowedInProgress) throw gbError('InProgress', `A ${inProgress} is in progress`);
  const head = readHead(wt);
  const wantHead = expect.head ?? null;
  if (wantHead !== null && head.oid !== wantHead) throw refMoved('HEAD');
  const expected = expect.refs ?? {};
  const names = new Set([...Object.keys(expected), ...extra]);
  if (head.branch !== null) names.add(`refs/heads/${head.branch}`);
  const refs = new Map([...names].map((n) => [n, readRef(wt.demo, n)] as const));
  for (const [name, want] of Object.entries(expected)) if (refs.get(name) !== want) throw refMoved(name);
  return { head, refs, inProgress };
}

/** What Undo/Redo and the banners show for the worktree: a banner for a stash git couldn't
 *  restore shows only while that stash is still listed (`Api::journal_state`). */
export function journalStateOf(ctx: DemoContext, wt: WriteWt): JournalState {
  const state = ctx.writes.journal(wt.root).state(inProgressName(wt.fs, wt.gitdir));
  const listed = new Set(wt.demo.stashes().map((s) => s.id));
  state.banners = state.banners.filter((b) => !['autostashRefused', 'autostashConflicts', 'autostashPartial'].includes(b.kind) || b.stash === null || listed.has(b.stash));
  return state;
}

const TREE_PATHS_CAP = 2000;

/** `journal::history::tree_paths`: what a commit, checkout or stash changed beyond its snapshots,
 *  sorted; null (every path) for a reset or rewind, or when it can't be told or is over the cap. */
export async function treePaths(wt: WriteWt, e: JournalEntry): Promise<string[] | null> {
  const strict = ['rewind', 'resetHard', 'resetMixed', 'resetSoft'].includes(e.undo);
  const relevant = e.headBefore.oid !== e.headAfter.oid || e.headBefore.branch !== e.headAfter.branch || e.indexBefore !== null || e.stashes.length > 0 || e.undo === 'switch' || e.undo === 'stash';
  if (strict || !relevant) return null;
  const set = new Set<string>();
  const add = async (a: string, b: string) => {
    for (const c of await diffTrees(wt.repo, a, b)) set.add(c.path);
  };
  if (e.headBefore.oid !== e.headAfter.oid) {
    if (e.headBefore.oid === null || e.headAfter.oid === null) return null;
    await add(e.headBefore.oid, e.headAfter.oid);
  }
  if (e.indexBefore !== null) {
    const to = e.indexAfter ?? e.headAfter.oid;
    if (to === null) return null;
    await add(e.indexBefore, to);
  }
  for (const m of e.stashes) {
    const parents = (await readCommit(wt.repo, m.oid)).parents;
    if (parents.length === 0) return null;
    await add(parents[0], m.oid);
    if (parents[1]) await add(parents[0], parents[1]);
    if (parents[2]) for (const p of (await listFiles(wt.repo, parents[2])).keys()) set.add(p);
  }
  return set.size > TREE_PATHS_CAP ? null : [...set].sort(compareBytewise);
}

/** `treePaths`, or null (every path) when an object can't be read, as the core logs and goes on. */
async function treePathsOrNull(wt: WriteWt, e: JournalEntry): Promise<string[] | null> {
  try {
    return await treePaths(wt, e);
  } catch {
    return null;
  }
}

/** §7.6: record the step, or clear the log for a write that moved HEAD or rewrote the index. */
function afterRun(log: StagingLog, effect: StagingEffect, label: string, before: IndexCapture | null, after: IndexCapture | null, ok: boolean, head: string | null): void {
  if (effect === 'step' && ok) {
    if (before && after) {
      if (!sameCapture(before, after)) log.record({ label, head, change: { kind: 'tree', before, after } });
    } else {
      log.keepResolves();
      log.redo = [];
    }
  } else if (effect === 'clear') log.clear();
}

type Ran<O> = ({ ok: true; value: O } | { ok: false; error: GbError }) & {
  moves: RefMove[];
  headBefore: HeadState;
  headAfter: HeadState;
  kinds: Set<ChangeKind>;
  journalChanged: boolean;
};

const NO_HEAD: HeadState = { branch: null, oid: null };

/** `Ran::failed`: a failure before anything ran (nothing moved). */
const failed = <O>(e: unknown, journalChanged = false): Ran<O> => ({ ok: false, error: asGbError(e), moves: [], headBefore: NO_HEAD, headAfter: NO_HEAD, kinds: new Set(), journalChanged });

/** Verify's observation: HEAD now, and the observed old → new of each ref; `known`, what it compared
 *  against (preflight's refs and the old value of each ref the run CAS-moved). */
function observe(wt: WriteWt, cx: WriteCx): { headAfter: HeadState; moves: RefMove[]; known: Map<string, string | null> } {
  const known = new Map(cx.before.refs);
  for (const [name, old] of cx.touched) if (!known.has(name)) known.set(name, old);
  const headAfter = readHead(wt);
  const moves: RefMove[] = [];
  for (const name of [...known.keys()].sort(compareBytewise)) {
    const old = known.get(name) ?? null;
    const now = readRef(wt.demo, name);
    if (old !== now) moves.push({ name, old, new: now });
  }
  return { headAfter, moves, known };
}

/** The rewrite marks' record, which the core only logs when it fails. */
export async function recordRewrite(ctx: DemoContext, wt: WriteWt, kind: RewriteKind | null, moves: RefMove[]): Promise<void> {
  try {
    await ctx.writes.recordRewrite(wt.repo, kind, moves);
  } catch {
    // As the core's `rewrites::record`: a mark that can't be kept is no failure of the write.
  }
}

/** Steps 2–9, under the lock. */
async function steps<O>(ctx: DemoContext, repoId: number, wt: WriteWt, expect: Expect, intent: WriteIntent<O>, op: number, box: { cx: WriteCx | null }, lock: HeldLock): Promise<Ran<O>> {
  let before: Before;
  try {
    before = preflight(wt, expect, intent.refs?.() ?? [], intent.allowedInProgress === true);
  } catch (e) {
    return failed(e);
  }
  const cx = new WriteCx({ ctx, wt, expect, before, op, repoId, lock });
  box.cx = cx;
  const early = (e: unknown): Ran<O> => failed(e, cx.journalChanged);
  // 2b. No merge in progress: a paused one ended outside GitVolt. It settles against what preflight
  //     saw, before this write plans anything.
  if (before.inProgress === null) {
    const settled = await settlePaused(cx, null);
    if (settled.restored !== null && !intent.onlySettles) {
      return early(gbError('Stale', `The ${settled.restored} ended outside GitVolt and your changes from before it are back; check them, then try again`));
    }
  }
  let plan: Plan;
  try {
    plan = intent.plan ? await intent.plan({ ctx, wt, expect, before }) : {};
  } catch (e) {
    return early(e);
  }
  // §6.1–6.2, before anything is written: the autostash plan, and the clean-restore question.
  let stashPlan: AutostashPlan | null;
  try {
    stashPlan = plan.autostash ? await planAutostash(wt, plan.autostash) : null;
  } catch (e) {
    return early(e);
  }
  if (stashPlan && stashPlan.conflicts.length > 0 && !intent.confirm?.autostash) {
    const target = stashPlan.target ?? '';
    return early({ ...gbError('Conflict', `Your changes conflict with ${target}`), detail: { kind: 'autostashConflict', paths: stashPlan.conflicts, target } });
  }
  // 3. The journal entry, written ahead.
  const journal = cx.journal;
  const undo = intent.undo();
  if (undo !== null) cx.entryId = journal.begin({ label: intent.label(), kind: intent.kind, headBefore: before.head, undo }, ctx.clock.nowMs());
  // 4. The snapshot.
  let ready: GbError | null = null;
  if (plan.snapshot) {
    try {
      const snap = await createSnapshot(wt, plan.snapshot.paths, plan.snapshot.untracked);
      cx.snapshot = snap;
      cx.editEntry((e) => {
        e.before = snap;
      });
    } catch (e) {
      ready = asGbError(e);
    }
  }
  // 5. The autostash, its kept record written ahead.
  let stash: Stashed | null = null;
  if (ready === null && stashPlan !== null) {
    try {
      stash = await saveAutostash(cx, stashPlan, intent.label());
      cx.autostashed = stash !== null;
    } catch (e) {
      ready = asGbError(e);
    }
  }
  const effect = intent.staging ?? 'clear';
  const stagingBefore = ready === null && effect === 'step' ? await captureIndex(wt).catch(() => null) : null;
  // 6. Run.
  let result: { ok: true; value: O } | { ok: false; error: GbError };
  if (ready !== null) result = { ok: false, error: ready };
  else {
    try {
      result = { ok: true, value: await intent.run(cx) };
    } catch (e) {
      result = { ok: false, error: asGbError(e) };
    }
  }
  // 7. Verify: the observed old → new of each ref, never the intended one.
  const { headAfter, moves, known } = observe(wt, cx);
  // 7b. This write started mid-merge and may have ended it (Commit, Abort): the pause settles.
  if (before.inProgress !== null && cx.paused === null) await settlePaused(cx, { entry: cx.entryId, moves });
  if (ready === null) {
    const stagingAfter = effect === 'step' && result.ok ? await captureIndex(wt).catch(() => null) : null;
    afterRun(ctx.writes.staging(wt.root), effect, intent.label(), stagingBefore, stagingAfter, result.ok, headAfter.oid);
  }
  // 8. The autostash comes back whatever the run did, unless a merge paused on conflicts.
  if (stash !== null) {
    if (cx.paused !== null) keepPaused(cx, stash);
    else settleAutostash(cx, stash, await restoreAutostash(cx, stash.oid, stash.message, true));
  }
  // 9. Finalize: done, dropped when nothing changed, or coalesced into the save below. A failure
  //    after a partial change still records what did change.
  const afterSnap = result.ok ? cx.after : null;
  const unchangedFailure = !result.ok && moves.length === 0 && sameHead(headAfter, before.head) && !cx.partial;
  let journalChanged = cx.journalChanged;
  if (cx.entryId !== null) {
    const id = cx.entryId;
    const e = journal.entry(id);
    if (e === null) {
      // Absorbed into the paused entry it completed (7b).
    } else if (cx.paused !== null) {
      // The entry waits, with what completion compares against.
      const p = cx.paused;
      const paused: PausedOp = { kind: p.kind, target: p.target, refsBefore: known, autostash: stash?.id ?? null, targetOid: p.targetOid, picked: p.picked, irebase: p.irebase };
      e.state = 'paused';
      e.headAfter = headAfter;
      e.paused = paused;
      journalChanged = true;
    } else if (unchangedFailure) journal.dropEntry(id);
    else {
      e.headAfter = headAfter;
      e.refs = moves;
      e.after = afterSnap;
      // UX Y: what a commit, checkout or stash changed beyond its snapshots (the dropdown's check).
      if (!sameHead(headAfter, before.head) || intent.undo() === 'stash') e.treePaths = await treePathsOrNull(wt, e);
      // UX G.2: a save on top of a save of the same file, with nothing changed in between, merges.
      const prev = intent.coalesces && cx.snapshot && afterSnap ? journal.below(id) : null;
      const into = prev && prev.label === intent.label() && prev.kind === intent.kind && prev.undo === 'restore' && prev.blocked === null && sameHead(prev.headAfter, headAfter) && prev.after && sameSnapshot(prev.after, cx.snapshot!) ? prev.id : null;
      journalChanged = (into !== null ? journal.coalesce(id, into) : journal.finalize(id, cx.keepRedo)) || journalChanged;
    }
  }
  // §12.3: a rewrite of a pushed branch records its lease; any move drops a mark it ended.
  const rewrite = result.ok && cx.paused === null ? (intent.rewrite?.() ?? null) : null;
  await recordRewrite(ctx, wt, rewrite, moves);
  // New commits join the graph's store.
  const tips = [...moves.map((m) => m.new), headAfter.oid, ...wt.demo.stashes().map((s) => s.id)].filter((x): x is string => x !== null);
  await wt.demo.addCommits(tips);
  const common = { moves, headBefore: before.head, headAfter, kinds: cx.kinds, journalChanged };
  return result.ok ? { ok: true, value: result.value, ...common } : { ok: false, error: result.error, ...common };
}

/** `steps`, with a bug past its own catches turned into a failure: the lock and queue go on, no
 *  pending entry stays behind, and the moves already made are still reported. */
async function guarded<O>(ctx: DemoContext, repoId: number, wt: WriteWt, expect: Expect, intent: WriteIntent<O>, op: number, lock: HeldLock): Promise<Ran<O>> {
  const box: { cx: WriteCx | null } = { cx: null };
  try {
    return await steps(ctx, repoId, wt, expect, intent, op, box, lock);
  } catch (e) {
    const cx = box.cx;
    if (!cx) return failed(e);
    let journalChanged = cx.journalChanged;
    if (cx.entryId !== null) {
      if (cx.entry()?.state === 'pending') cx.journal.dropEntry(cx.entryId);
      else journalChanged = true;
    }
    try {
      const { headAfter, moves } = observe(wt, cx);
      return { ...failed<O>(e, journalChanged), moves, headBefore: cx.before.head, headAfter, kinds: cx.kinds };
    } catch {
      return failed(e, journalChanged);
    }
  }
}

export async function runWrite<O>(ctx: DemoContext, repoId: number, worktree: string, expect: Expect, intent: WriteIntent<O>): Promise<WriteResult<O>> {
  ctx.repos.get(repoId);
  const op = ctx.writes.nextOp();
  try {
    return await runOp(ctx, repoId, worktree, expect, intent, op);
  } finally {
    ctx.writes.ended(op);
  }
}

async function runOp<O>(ctx: DemoContext, repoId: number, worktree: string, expect: Expect, intent: WriteIntent<O>, op: number): Promise<WriteResult<O>> {
  const queue = ctx.writes.queue(repoId, ctx.emit);
  const label = intent.label();
  // 1. Queue and lock: a queued write joins before anything awaits, so the queue's order is the
  //    click order; an error before its turn takes it out again, and a Cancel while it waits too.
  const ticket = (intent.class ?? 'queued') === 'queued' ? queue.enqueue(label, intent.kind, op) : null;
  if (ticket) ctx.writes.queued(op, queue, ticket);
  let wt: WriteWt;
  try {
    wt = await writeTarget(ctx, repoId, worktree);
  } catch (e) {
    if (ticket) queue.drop(ticket);
    throw e;
  }
  // The op starts once its queue slot is taken, before the lock (as the core's does).
  const started = () => ctx.emit({ type: 'opStarted', op, kind: intent.kind, repo: repoId, label, interactive: true });
  let release: () => void;
  let shown = expect;
  if (ticket) {
    const slot = await queue.turn(ticket, started);
    shown = slot.carry(expect);
    // The transfer first holds only the slot (the core's `transfer_first`).
    if (intent.transferFirst) {
      try {
        await intent.transferFirst(ctx, op, repoId);
      } catch (e) {
        const err = asGbError(e);
        // As the core: the lock, the fresh lists and `repoChanged` (worktree, index) still come
        // before `opFinished`, though nothing was written.
        const release = await slot.lock();
        const wip: WipListsPayload | null = await wipLists(wt).catch(() => null);
        release();
        queue.finish(err, []);
        ctx.emit({ type: 'repoChanged', repo: repoId, kinds: ['worktree', 'index'], worktrees: [wt.root], versions: wip ? { [wt.root]: wip.version } : {} });
        ctx.emit({ type: 'opFinished', op, kind: intent.kind, repo: repoId, outcome: err.kind === 'Cancelled' ? 'cancelled' : 'failed', message: err.message, command: null });
        throw err;
      }
    }
    release = await slot.lock();
  } else {
    started();
    release = await queue.lock();
  }
  // `guarded` and `wipLists` never throw, so the lock and the queue slot are always given back.
  const lock = new HeldLock(() => queue.lock(), release);
  const ran = await guarded(ctx, repoId, wt, shown, intent, op, lock);
  // 10. The fresh lists, after the write's last change; none when they can't be read (the core's too).
  const wip: WipListsPayload | null = await wipLists(wt).catch(() => null);
  lock.done();
  if (ticket) {
    // A failure stops only the items queued behind it; a Cancel stops nothing.
    const carried = ran.headBefore.oid !== ran.headAfter.oid ? [...ran.moves, { name: 'HEAD', old: ran.headBefore.oid, new: ran.headAfter.oid }] : ran.moves;
    queue.finish(ran.ok ? null : ran.error, carried);
  }
  const kinds = new Set(ran.kinds);
  kinds.add('worktree');
  kinds.add('index');
  if (ran.moves.length > 0) kinds.add('refs');
  if (!sameHead(ran.headBefore, ran.headAfter)) kinds.add('head');
  ctx.emit({ type: 'repoChanged', repo: repoId, kinds: KIND_ORDER.filter((k) => kinds.has(k)), worktrees: [wt.root], versions: wip ? { [wt.root]: wip.version } : {} });
  if (ran.moves.length > 0) ctx.emit({ type: 'refsUpdated', repo: repoId });
  const journal = journalStateOf(ctx, wt);
  if (ran.journalChanged) ctx.emit({ type: 'journalChanged', repo: repoId, worktree: wt.root, state: journal });
  ctx.emit({ type: 'opFinished', op, kind: intent.kind, repo: repoId, outcome: ran.ok ? 'ok' : ran.error.kind === 'Cancelled' ? 'cancelled' : 'failed', message: ran.ok ? null : ran.error.message, command: null });
  const conflicted = wip?.unstaged.files.some((f) => f.status === 'U') ?? false;
  const staging = stagingStateOf(ctx.writes.staging(wt.root), conflicted);
  if (!ran.ok) throw ran.error;
  return { outcome: ran.value, journal, staging, wip };
}
