// Phase 4's one door into phase 3's write layer (plan 4, "Built on phase 3"): phase 3's functions,
// re-exported or adapted to the shapes the sequencer, the remotes and the forge use. A phase-3
// rename or reshape changes this file only.
import type { ChangeKind } from '../../api/gen/ChangeKind';
import type { Confirm } from '../../api/gen/Confirm';
import type { Expect } from '../../api/gen/Expect';
import type { IntegrateOutcome } from '../../api/gen/IntegrateOutcome';
import type { OpKind } from '../../api/gen/OpKind';
import type { PausedKind } from '../../api/gen/PausedKind';
import type { RewriteKind } from '../../api/gen/RewriteKind';
import type { WriteResult } from '../../api/gen/WriteResult';
import { branchNameError } from '../../branches/branchName';
import { remoteNameError as remoteNameErrorUi } from '../../forge/remoteUrl';
import type { DemoClock, DemoContext } from '../context';
import { asGbError } from './errors';
import { AttrReader, markerSizeOf } from './read/attributes';
import type { IndexEntry } from './read/indexFile';
import { compareBytewise } from './read/bytes';
import { demoOf, fail, type ReadRepo } from './read/seam';
import { listFiles, MODE_GITLINK, readBlobBytes } from './read/trees';
import { listWorktrees } from './read/worktrees';
import type { DemoRepo } from './repo';
import type { AutostashRule } from './write/autostash';
import { branchConfig, configChanges, readLocalConfig as readConfig3, removeBranchSection, removeConfigSection as removeSection3, setConfigValues as setConfig3, type ConfigChange } from './write/config';
import { loadIndex } from './write/index';
import { inProgressName as inProgressName3, type OpName } from './write/inProgress';
import type { IrebasePause, UndoKind } from './write/journal';
import { applyMerge as applyMerge3, mergeTrees as mergeTrees3, resultTree, type TreeMerge } from './write/mergeTrees';
import { refuseIndexFor, refuseLocalChanges, runMerge as runMerge3, type PickRefusal } from './write/mergeRun';
import { writeOrigHead as writeOrigHead3 } from './write/mergeState';
import { hardReset, twoWayMove } from './write/move';
import { demoIdent, DEMO_IDENTITY, identLine, writeCommitObject as writeCommit3, writeIndexTree, writeTreeOf } from './write/objects';
import { appendReflog, casRefs, setHead as setHead3, type RefMove } from './write/refs';
import { NO_EXPECT, runWrite as runWrite3, type Plan as Plan3, type Pre as Pre3, type StagingEffect, type WriteCx as WriteCx3, type WriteIntent as WriteIntent3 } from './write/run';
import { writeTarget, type WriteWt } from './write/seam';
import { storeStash } from './write/stash';
import { createSnapshot } from './write/snapshot';
import { dirty as dirty3 } from './write/status';
import { readHead as readHead3 } from './write/refs';

export { isRemoteKey } from './write/removedRemote';
export { readInProgress, inProgressName, conflicted, indexEntries } from './write/inProgress';
export { cleanupStrip, cleanupWhitespace, rawAuthor, writeBlobBytes, writeRawObject } from './write/objects';
/** A commit's author key as completion compares them: `<email> <seconds> <zone>`. */
export { keyOf as authorKey } from './write/settle';
export { deleteRefFiles, readRef, refMoved, shortRef } from './write/refs';
export { reflogMessage } from './write/stash';
export { statusEntries } from './write/status';
export { withConflicts } from './write/mergeState';
export { branchNameError };
export type { AutostashRule, RefMove, ConfigChange, IrebasePause, OpName, UndoKind };

/** An author or committer; `timezoneOffset` in minutes east of UTC (+0100 is 60). */
export interface Signature {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}
export interface OpHandle {
  id: number;
  cancelled(): boolean;
  onCancel(f: () => void): void;
}
export interface Pre {
  ctx: DemoContext;
  repo: DemoRepo;
  read: ReadRepo;
  root: string;
  gitdir: string;
  expect: Expect;
  /** `head.branch` is the short name. */
  before: { head: { oid: string | null; branch: string | null }; refs: Map<string, string | null>; inProgress: OpName | null };
}
export interface Pause {
  kind: PausedKind;
  target: string;
  targetOid: string | null;
  picked: string[];
  /** GitVolt's interactive rebase (its session rides on the paused entry). */
  irebase: boolean;
}
export interface WriteCx extends Pre {
  op: number;
  opHandle: OpHandle;
  /** Phase 3's CAS; branch reflogs aren't written (phase 3's decision), so `reflog` goes unused. */
  cas(moves: RefMove[], reflog: string): Promise<void>;
  touch(kind: ChangeKind): void;
  /** Read, it's a fresh copy of phase 3's: assign a whole new value to change it. */
  paused: Pause | null;
  recordConfig(c: ConfigChange[]): void;
  /** `f` with the write lock released (a push's transfer): only the queue's running slot is held,
   *  and the lock is taken again before it returns (`WriteCx::network`). */
  network<T>(f: () => Promise<T>): Promise<T>;
}
export interface Plan {
  autostash?: { rule: AutostashRule; target: string | null; op: string; targetName: string | null };
  snapshot?: { paths: string[]; untracked?: string[] };
}
export interface WriteIntent<T> {
  kind: OpKind;
  label(): string;
  undo: UndoKind | null;
  refs?(): string[];
  allowedInProgress?: boolean;
  confirm?: Confirm;
  /** The staging undo log's part (default `clear`): a write that leaves the index alone keeps it. */
  staging?: StagingEffect;
  /** What it rewrote when it completes (the rewrite marks): a rebase, an amend. */
  rewrite?(): RewriteKind | null;
  /** The transfer a write makes first (a pull's fetch, `transfer_first`): after the queue slot, before
   *  the write lock and preflight, outside the journal entry. A throw ends the write unjournaled. */
  transferFirst?(ctx: DemoContext, op: OpHandle, repo: number): Promise<void>;
  plan?(pre: Pre): Promise<Plan>;
  run(cx: WriteCx): Promise<T>;
}
/** Phase 3's tree merge as this plan reads it: the tree when clean, the index (stages included) and
 *  each worktree file the merge writes (null: removed). */
export interface MergeResult {
  raw: TreeMerge;
  tree: string | null;
  conflicts: string[];
  index: IndexEntry[];
  files: Map<string, { bytes: Uint8Array; mode: number } | null>;
}

export { NO_EXPECT };
/** The empty tree's id; `writeTreeOf(read, [])` writes the object. */
export { EMPTY_TREE, writeTreeOf } from './write/objects';
export const nowSeconds = (ctx: DemoContext): number => Math.floor(ctx.clock.nowMs() / 1000);

/** Each view keeps the phase-3 object it shows, out of sight of the plan's code. */
const RAW = Symbol('phase 3');
type Viewed = { [RAW]: Pre3 | WriteCx3 };
const raw = (v: Pre): Pre3 | WriteCx3 => (v as Pre & Viewed)[RAW];
const rawCx = (v: WriteCx): WriteCx3 => (v as WriteCx & Viewed)[RAW] as WriteCx3;

function preOf(p: Pre3): Pre {
  const view: Pre = { ctx: p.ctx, repo: p.wt.demo, read: p.wt.repo, root: p.wt.root, gitdir: p.wt.gitdir, expect: p.expect, before: { head: { ...p.before.head }, refs: p.before.refs, inProgress: p.before.inProgress } };
  Object.defineProperty(view, RAW, { value: p, enumerable: false });
  return view;
}

function cxOf(c: WriteCx3): WriteCx {
  const view = preOf(c) as WriteCx;
  Object.defineProperty(view, 'paused', {
    enumerable: true,
    get: (): Pause | null => (c.paused === null ? null : { kind: c.paused.kind, target: c.paused.target, targetOid: c.paused.targetOid, picked: c.paused.picked, irebase: c.paused.irebase !== null }),
    // A new stop of the same session keeps what it made and moved so far.
    set: (v: Pause | null) => {
      c.paused = v === null ? null : { kind: v.kind, target: v.target, targetOid: v.targetOid, picked: v.picked, irebase: v.irebase ? (c.journal.paused()?.paused?.irebase ?? { made: [], moved: [] }) : null };
    },
  });
  view.op = c.op;
  view.opHandle = opHandle(c.ctx, c.op);
  view.cas = async (moves) => c.cas(moves);
  view.touch = (k) => c.touch(k);
  view.recordConfig = (ch) => c.recordConfig(ch);
  view.network = (f) => c.network(f);
  return view;
}

function planOf(p: Plan): Plan3 {
  return { ...(p.autostash ? { autostash: p.autostash } : {}), ...(p.snapshot ? { snapshot: { paths: p.snapshot.paths, untracked: p.snapshot.untracked ?? [] } } : {}) };
}

/** A worktree as a handler sees it before it queues a write: HEAD's branch (null: detached) and
 *  the operation in progress. */
export async function worktreeNow(ctx: DemoContext, repo: number, worktree: string): Promise<{ branch: string | null; inProgress: ReturnType<typeof inProgressName3> }> {
  const wt = await writeTarget(ctx, repo, worktree);
  return { branch: readHead3(wt).branch, inProgress: inProgressName3(wt.fs, wt.gitdir) };
}

export function runWrite<T>(ctx: DemoContext, repo: number, worktree: string, expect: Expect, i: WriteIntent<T>): Promise<WriteResult<T>> {
  const intent: WriteIntent3<T> = {
    kind: i.kind,
    label: () => i.label(),
    undo: () => i.undo,
    ...(i.refs ? { refs: () => i.refs!() } : {}),
    ...(i.allowedInProgress ? { allowedInProgress: true } : {}),
    ...(i.confirm ? { confirm: i.confirm } : {}),
    ...(i.staging ? { staging: i.staging } : {}),
    ...(i.rewrite ? { rewrite: () => i.rewrite!() } : {}),
    ...(i.transferFirst ? { transferFirst: (c: DemoContext, op: number, repoId: number) => i.transferFirst!(c, opHandle(c, op), repoId) } : {}),
    ...(i.plan ? { plan: async (p: Pre3) => planOf(await i.plan!(preOf(p))) } : {}),
    run: (c: WriteCx3) => i.run(cxOf(c)),
  };
  return runWrite3(ctx, repo, worktree, expect, intent);
}

/** The core's `watch_refs`: refs the journal records as they are now, beside HEAD's branch (a
 *  paused entry's `refsBefore` too, so a Continue that moves them later is recorded). */
export function watchRefs(cx: WriteCx, refs: [string, string | null][]): void {
  const known = rawCx(cx).before.refs;
  for (const [name, oid] of refs) if (!known.has(name)) known.set(name, oid);
}

/** Refs git moves itself as the write runs (a rebase's finish): CAS-checked, but not the write's
 *  own moves. The core's verify sees only the refs preflight read (HEAD's branch, the intent's) and
 *  those it CAS-moved, so a Continue on a detached HEAD reports none (write/mod.rs step 7). */
export function gitMovesRefs(cx: WriteCx, moves: RefMove[]): void {
  casRefs(rawCx(cx).wt.demo, moves);
}

/** `refsUpdated` in the middle of a write (the core's rebase `head_ticker`: a progress tick on which
 *  HEAD moved reloads the graph before the write ends). */
export function refsTick(cx: WriteCx): void {
  const c = rawCx(cx);
  c.ctx.emit({ type: 'refsUpdated', repo: c.repoId });
}

/** `ORIG_HEAD` (git sets it as a rebase starts, and as a merge or a reset moves HEAD). */
export function writeOrigHead(cx: Pre, oid: string): void {
  writeOrigHead3(raw(cx).wt, oid);
}

/** The paused entry's interactive-rebase session, edited in place: a commit made at a stop joins
 *  `made`, the refs a Continue moves join `moved`. Nothing when no such session waits. */
export function notePaused(cx: WriteCx, f: (irebase: IrebasePause) => void): void {
  const c = rawCx(cx);
  const session = c.journal.paused()?.paused?.irebase;
  if (!session) return;
  f(session);
  c.journalChanged = true;
}

/** The paused entry's interactive-rebase session (what was made at its stops), or null. */
export function pausedSession(cx: Pre): IrebasePause | null {
  return raw(cx).ctx.writes.journal(raw(cx).wt.root).paused()?.paused?.irebase ?? null;
}

/** The autostash the paused entry holds (its stash's oid), or null. */
export function pausedAutostash(cx: Pre): string | null {
  const j = raw(cx).ctx.writes.journal(raw(cx).wt.root);
  const id = j.paused()?.paused?.autostash ?? null;
  return id === null ? null : (j.keptById(id)?.oid ?? null);
}

/** The work an interactive rebase's Abort keeps (the core's `store_kept`, then `finish_kept_work`):
 *  the stash commit `oid` listed with `message`, and its kept record, the "work from the stop"
 *  banner (`target`: the branch its commits went on). Not a stash of the write's own: the abort
 *  has no journal entry. */
export function keepAbortedWork(cx: WriteCx, k: { oid: string; message: string; label: string; target: string | null }): void {
  const c = rawCx(cx);
  storeStash(c.wt, c.ident(), k.oid, k.message);
  c.journal.keep({ oid: k.oid, message: k.message, label: k.label, target: k.target, reason: { status: 'abortedWork' }, createdMs: c.ctx.clock.nowMs() });
  c.journalChanged = true;
  c.touch('stash');
}

/** The core's `record_on_paused`: ref moves (the session's `moved`, which settle keeps either way)
 *  and config changes, on the paused entry as they happen. False, and nothing recorded, when no
 *  interactive-rebase session waits. */
export function recordOnPaused(cx: WriteCx, moves: RefMove[], changes: ConfigChange[]): boolean {
  const c = rawCx(cx);
  const e = c.journal.paused();
  const session = e?.paused?.irebase;
  if (!e || !session) return false;
  if (moves.length === 0 && changes.length === 0) return true;
  e.config.push(...changes);
  session.moved.push(...moves);
  if (changes.length > 0) c.touch('config');
  c.journalChanged = true;
  return true;
}

const identOf = (s: string | Signature): string => (typeof s === 'string' ? s : identLine(s.name, s.email, s.timestamp, s.timezoneOffset));

/** A commit object. An author or committer is a raw ident (as stored: `rawAuthor` keeps a picked
 *  commit's zone) or a `Signature`; a missing one is the visitor at the demo's clock. */
export function writeCommitObject(read: ReadRepo, c: { tree: string; parents: string[]; message: string; author?: string | Signature; committer?: string | Signature }, at: { clock: DemoClock }): Promise<string> {
  const you = demoIdent(at.clock);
  return writeCommit3(read, { tree: c.tree, parents: c.parents, message: c.message, author: c.author === undefined ? you : identOf(c.author), committer: c.committer === undefined ? you : identOf(c.committer) });
}

/** A ref's CAS (`next` null deletes); a tracking ref also gets its reflog line, as the visitor at
 *  `now` (1b's `lastPush` reads them). */
export async function updateRef(read: ReadRepo, _gitdir: string, name: string, old: string | null, next: string | null, reflog: string, now: number): Promise<void> {
  const demo = demoOf(read);
  casRefs(demo, [{ name, old, new: next }]);
  if (name.startsWith('refs/remotes/') && next !== null) appendReflog(demo, name, old, next, identLine(DEMO_IDENTITY.name, DEMO_IDENTITY.email, now, 0), reflog);
}

/** The write target whose own git dir is `gitdir`. */
async function wtOf(read: ReadRepo, gitdir: string): Promise<WriteWt> {
  const demo = demoOf(read);
  const w = (await listWorktrees(read)).find((x) => x.gitdir === gitdir) ?? fail('InvalidInput', `${gitdir} is no worktree's git dir`);
  return { repo: read, demo, fs: demo.fs, root: w.path, gitdir, isMain: w.isMain };
}

export async function setHead(read: ReadRepo, gitdir: string, to: { detached: string } | { branch: string }): Promise<void> {
  setHead3(await wtOf(read, gitdir), 'detached' in to ? { oid: to.detached } : { branch: to.branch.replace(/^refs\/heads\//, '') });
}

export async function readIndexEntries(read: ReadRepo, gitdir: string): Promise<IndexEntry[]> {
  return loadIndex(await wtOf(read, gitdir));
}
/** `git write-tree`: a conflicted index refuses (`Conflict`). */
export async function writeTreeFromIndex(read: ReadRepo, gitdir: string): Promise<string> {
  return writeIndexTree(read, await readIndexEntries(read, gitdir));
}

/** Phase 3's three-way tree merge (no base: two additions from the empty tree), the conflict
 *  markers' length from `.gitattributes` as a merge's (a view with no repository handle: 7). `labels.base` isn't shown: the merge style
 *  is git's default. */
export async function mergeTrees(read: ReadRepo, m: { base: string | null; ours: string; theirs: string; labels: { ours: string; theirs: string; base: string } }): Promise<MergeResult> {
  const base = m.base ?? (await writeTreeOf(read, []));
  // A bare git dir's view (an origin's, the forge's merges) has no worktree or index to read
  // attributes from: git's default markers.
  const attrs = read.demo === null ? null : new AttrReader(read, read.dir);
  const merged = await mergeTrees3(read, base, m.ours, m.theirs, { ours: m.labels.ours, theirs: m.labels.theirs }, attrs === null ? undefined : (p) => markerSizeOf(attrs, p));
  const files: MergeResult['files'] = new Map();
  for (const [p, w] of merged.worktree) files.set(p, w === null ? null : 'bytes' in w ? { bytes: w.bytes, mode: w.mode } : { bytes: await readBlobBytes(read, w.oid), mode: w.mode });
  return { raw: merged, tree: merged.conflicts.length > 0 ? null : await resultTree(read, merged), conflicts: merged.conflicts, index: merged.entries, files };
}

/** What `git merge` refuses before writing `r` (an unmerged index, a staged change, a local change
 *  or an untracked file in its way): it throws, and nothing is written. */
export async function refuseMergeOver(cx: Pre, r: MergeResult, how?: PickRefusal): Promise<void> {
  await refuseLocalChanges(raw(cx).wt, r.raw, how);
}

/** A committing cherry-pick or revert's start: git's refusal of an unmerged or staged index. */
export async function refuseIndexForPick(cx: Pre, how: PickRefusal): Promise<void> {
  await refuseIndexFor(raw(cx).wt, how);
}

export type { PickRefusal };

/** The merge written into the worktree and the index (stages included). */
export async function applyMerge(cx: Pre, _fromTree: string, r: MergeResult): Promise<void> {
  await applyMerge3(raw(cx).wt, r.raw);
}

/** The index and worktree moved from the tree-ish `from` to `to`; without `force` a local change in
 *  the way refuses and changes nothing (`DirtyWorktree`, or `Other` when only untracked files would
 *  be lost, as git's), in the words of git's `verb` (a pick's commit is a merge's). */
export async function checkoutTree(cx: Pre, from: string, to: string, opts?: { force?: boolean; verb?: 'checkout' | 'merge' }): Promise<void> {
  const wt = raw(cx).wt;
  if (opts?.force) await hardReset(wt, to);
  else await twoWayMove(wt, from, to, opts?.verb ?? 'checkout');
}

/** `git merge` of `target` into HEAD's branch (`--ff-only`); a stop on conflicts pauses the write.
 *  `kinds`: what it marks changed (the core's `run_merge` by default). */
export function runMerge(cx: WriteCx, target: string, label: string, ffOnly: boolean, kinds?: readonly ChangeKind[]): Promise<IntegrateOutcome> {
  return runMerge3(rawCx(cx), target, label, ffOnly, kinds);
}

/** The core's `remote_name_error` (the UI's twin), with no names taken. */
export const remoteNameError = (name: string): string | null => remoteNameErrorUi(name, []);

export async function setConfigValues(read: ReadRepo, key: string, values: string[]): Promise<void> {
  setConfig3(demoOf(read), key, values);
}
export async function removeConfigSection(read: ReadRepo, section: string): Promise<void> {
  removeSection3(demoOf(read), section);
}
/** `git config --remove-section branch.<name>` (a deleted branch's keys); what it removed, not yet
 *  recorded. */
export function removeBranchConfig(read: ReadRepo, name: string): ConfigChange[] {
  const demo = demoOf(read);
  const before = branchConfig(demo, name);
  if (before.size === 0) return [];
  removeBranchSection(demo, name);
  return configChanges(before, new Map());
}
export async function readLocalConfig(read: ReadRepo): Promise<[string, string][]> {
  return readConfig3(demoOf(read));
}

export function opHandle(ctx: DemoContext, op: number): OpHandle {
  const w = ctx.writes;
  return { id: op, cancelled: () => w.cancelled(op), onCancel: (f) => w.onCancel(op, f) };
}
export function beginOp(ctx: DemoContext): OpHandle {
  return opHandle(ctx, ctx.writes.nextOp());
}

/** `f` in the repository's queue: it waits its turn (a Cancel meanwhile takes it out), runs, and
 *  finishes the item with its failure; the op ends with it. It holds the running slot, never the
 *  write lock (the core's user fetch, Deviation 8): immediate writes go on meanwhile. */
export async function withQueueSlot<T>(ctx: DemoContext, repo: number, label: string, kind: OpKind, op: number, f: () => Promise<T>): Promise<T> {
  try {
    const q = ctx.writes.queue(repo, ctx.emit);
    const ticket = q.enqueue(label, kind, op);
    ctx.writes.queued(op, q, ticket);
    await q.turn(ticket);
    try {
      const out = await f();
      q.finish(null, []);
      return out;
    } catch (e) {
      q.finish(asGbError(e), []);
      throw e;
    }
  } finally {
    ctx.writes.ended(op);
  }
}

// --- a "without committing" pick's journal entry (the core's sequence.rs `run_no_commit`) ---

/** `precheck::dirty`: the paths with index or worktree changes (a rename's both), the untracked
 *  ones, the conflicted ones, and how many are conflicted. */
export async function dirtyPaths(cx: Pre): Promise<{ tracked: string[]; untracked: string[]; unmerged: string[]; conflicted: number }> {
  const d = await dirty3(cx.read, cx.root);
  return { tracked: [...d.tracked], untracked: [...d.untracked], unmerged: d.unmerged, conflicted: d.conflicted };
}

/** A removed remote's symbolic refs, for its Undo (the entry's ref moves name concrete refs only);
 *  the entry is partial, as the core's is when there are any. */
export function recordRemovedRemote(cx: WriteCx, name: string, symrefs: [string, string][]): void {
  const c = rawCx(cx);
  c.editEntry((e) => {
    e.removedRemote = { name, symrefs };
  });
  if (symrefs.length > 0) c.partial = true;
  c.journalChanged = true;
}

/** The entry's `StoppedPick` marker (its Undo asks, then discards what the run changed). */
export function markStoppedPick(cx: WriteCx, op: string, paths: Iterable<string>): void {
  const c = rawCx(cx);
  c.editEntry((e) => {
    e.stoppedPick = { op, paths: [...paths].sort(compareBytewise) };
  });
  c.journalChanged = true;
}

/** The worktree may have changed before a failure: the entry is kept then. */
export function markPartial(cx: WriteCx): void {
  rawCx(cx).partial = true;
}

/** The plan's `before` snapshot's paths. */
export function snapshotPaths(cx: WriteCx): string[] | null {
  return rawCx(cx).snapshot?.paths ?? null;
}

/** `paths` join the `before` snapshot as HEAD holds them (the state they were in: git refuses to
 *  touch a dirty path), so the entry's Undo puts them back. */
export async function widenSnapshot(cx: WriteCx, paths: string[]): Promise<void> {
  const c = rawCx(cx);
  const snap = c.snapshot;
  if (!snap) return;
  const head = readHead3(c.wt).oid;
  const files = head === null ? new Map<string, { mode: number; oid: string }>() : await listFiles(c.wt.repo, head);
  for (const p of paths) {
    if (snap.held.has(p)) continue;
    const e = files.get(p);
    snap.paths.push(p);
    if (!e) {
      snap.held.set(p, { index: null, file: null, clean: false });
      continue;
    }
    const file = e.mode === MODE_GITLINK ? { mode: MODE_GITLINK, bytes: new Uint8Array() } : { mode: e.mode, bytes: await readBlobBytes(c.wt.repo, e.oid) };
    snap.held.set(p, { index: { mode: e.mode, oid: e.oid }, file, clean: true });
  }
  // The entry's `before` is the same snapshot; set explicitly, not relied on.
  c.editEntry((e) => {
    e.before = snap;
  });
  c.journalChanged = true;
}

/** The `after` snapshot, over the `before` one's paths: what Redo restores. */
export async function snapshotAfter(cx: WriteCx): Promise<void> {
  const c = rawCx(cx);
  const snap = c.snapshot;
  if (!snap) fail('Other', 'the pick has no snapshot');
  c.after = await createSnapshot(c.wt, snap.paths, snap.untracked);
}
