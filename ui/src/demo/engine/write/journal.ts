// The undo/redo journal (spec #2 §5.1): the core's journal/mod.rs and journal/history.rs, in memory,
// one per worktree for the page's life. Entries are written ahead (pending), then finalised (done)
// or dropped when nothing changed; Undo and Redo move them between the stacks; kept stashes have
// banners; a merge, rebase or pick stopped on conflicts waits as a paused entry. Not here (nothing in
// the demo can need them): the file and its lock, owners, crash recovery, expiry.
import type { Banner } from '../../../api/gen/Banner';
import type { BannerKind } from '../../../api/gen/BannerKind';
import type { HistoryRow } from '../../../api/gen/HistoryRow';
import type { JournalState } from '../../../api/gen/JournalState';
import type { OpKind } from '../../../api/gen/OpKind';
import type { PausedKind } from '../../../api/gen/PausedKind';
import { compareBytewise } from '../read/bytes';
import type { ConfigChange } from './config';
import { shortRef, type HeadState, type RefMove } from './refs';
import type { Snapshot } from './snapshot';

export type UndoKind = 'moveRefs' | 'rewind' | 'switch' | 'restore' | 'barrier' | 'moveHead' | 'rename' | 'stash' | 'resetSoft' | 'resetMixed' | 'resetHard';
export type EntryState = 'pending' | 'done' | 'paused';

export const MAX_ENTRIES = 50;
export const HISTORY_ROWS = 10;
export const UNVERIFIED = "Can't be undone: GitVolt couldn't read what it changed";

export interface StashMove {
  oid: string;
  message: string;
  /** True: the op created it; false: it dropped it. */
  created: boolean;
  withoutIndex: boolean;
}

export type KeptReason =
  | { status: 'pending' }
  | { status: 'refused' }
  | { status: 'conflicts'; files: number; binary: boolean }
  | { status: 'partialRestore' }
  | { status: 'stopped'; phase: 'push' | 'apply' }
  | { status: 'interrupted' }
  | { status: 'paused' }
  /** The work done at an interactive rebase's stop, saved before its Abort reset it (the core's
   *  `AbortedWork`): the stash is the only copy, so Drop is refused. */
  | { status: 'abortedWork' };

export interface KeptStash {
  id: number;
  oid: string | null;
  message: string;
  label: string;
  target: string | null;
  reason: KeptReason;
  createdMs: number;
}

/** An interactive rebase's session, as the pause carries it (the core's `IrebaseState`): the
 *  commits made at its stops, and the refs its Continue moved as it went (chips, deletes). */
export interface IrebasePause {
  made: string[];
  moved: RefMove[];
}

export interface PausedOp {
  kind: PausedKind;
  target: string;
  refsBefore: Map<string, string | null>;
  autostash: number | null;
  targetOid: string | null;
  picked: string[];
  irebase: IrebasePause | null;
}

/** A "without committing" pick that stopped on conflicts (the core's `StoppedPick`): its Undo asks,
 *  then discards what the run changed. */
export interface StoppedPick {
  /** What git calls it: `cherry-pick` or `revert`. */
  op: string;
  /** The paths the commits it applied, and the one it stopped on, changed (and the paths the run
   *  changed outside P): discarded without a stash; the rest of P keeps the usual autostash rule. */
  paths: string[];
}

export interface JournalEntry {
  id: number;
  atMs: number;
  label: string;
  kind: OpKind;
  state: EntryState;
  headBefore: HeadState;
  headAfter: HeadState;
  refs: RefMove[];
  config: ConfigChange[];
  before: Snapshot | null;
  after: Snapshot | null;
  stashes: StashMove[];
  /** The pre-op index as a tree ("Stage all & commit"). */
  indexBefore: string | null;
  /** The post-op index tree, when it isn't `headAfter`'s tree. */
  indexAfter: string | null;
  undo: UndoKind;
  blocked: string | null;
  paused: PausedOp | null;
  stoppedPick: StoppedPick | null;
  note: string | null;
  /** What a commit, checkout or stash changed beyond its snapshots (the dropdown's dependency check). */
  treePaths: string[] | null;
  /** A removed remote's symbolic refs (`refs/remotes/<name>/HEAD`), which the ref moves can't carry. */
  removedRemote?: RemovedRemote;
}

export interface RemovedRemote {
  name: string;
  symrefs: [string, string][];
}

export interface NewEntry {
  label: string;
  kind: OpKind;
  headBefore: HeadState;
  undo: UndoKind;
}

export const sameHead = (a: HeadState, b: HeadState): boolean => a.branch === b.branch && a.oid === b.oid;

/** Anything happened: a ref or HEAD moved, files were snapshotted, a stash or config changed, or it's a barrier. */
export function changed(e: JournalEntry): boolean {
  return e.undo === 'barrier' || e.blocked !== null || e.indexAfter !== null || e.refs.length > 0 || !sameHead(e.headBefore, e.headAfter) || e.before !== null || e.after !== null || e.stashes.length > 0 || e.config.length > 0;
}

function fresh(id: number, e: NewEntry, now: number): JournalEntry {
  return {
    id, atMs: now, label: e.label, kind: e.kind, state: 'pending', headBefore: e.headBefore, headAfter: { ...e.headBefore },
    refs: [], config: [], before: null, after: null, stashes: [], indexBefore: null, indexAfter: null, undo: e.undo, blocked: null, paused: null, stoppedPick: null, note: null, treePaths: null,
  };
}

/** Removes `stack[..end]` except paused entries, which stay where they were; the removed ones. */
function drainUnpaused(stack: JournalEntry[], end: number): JournalEntry[] {
  const head = stack.slice(0, end);
  stack.splice(0, stack.length, ...head.filter((e) => e.state === 'paused'), ...stack.slice(end));
  return head.filter((e) => e.state !== 'paused');
}

/** The 50-entry cap: the oldest go, never a paused one. */
function cap(stack: JournalEntry[]): void {
  while (stack.length > MAX_ENTRIES) {
    const i = stack.findIndex((e) => e.state !== 'paused');
    if (i < 0) break;
    stack.splice(i, 1);
  }
}

// --- the dropdown (history.rs) ---
interface Touched {
  paths: Set<string>;
  allPaths: boolean;
  writes: Set<string>;
  reads: Set<string>;
}

const STRICT: UndoKind[] = ['rewind', 'resetHard', 'resetMixed', 'resetSoft'];
const sorted = (s: Iterable<string>) => [...s].sort(compareBytewise);

function recordable(e: JournalEntry): boolean {
  return e.headBefore.oid !== e.headAfter.oid || e.headBefore.branch !== e.headAfter.branch || e.indexBefore !== null || e.indexAfter !== null || e.stashes.length > 0 || e.undo === 'switch' || e.undo === 'stash';
}

function touched(e: JournalEntry): Touched | string {
  if (e.state === 'pending') return 'Another action is still running';
  if (e.state === 'paused') return `Finish or abort the ${e.label} first`;
  if (e.undo === 'barrier') return `A later push can't be undone (${e.label})`;
  if (e.blocked !== null || e.paused !== null || e.stoppedPick !== null) return `A later action can't be checked (${e.label})`;
  const t: Touched = { paths: new Set(), allPaths: false, writes: new Set(), reads: new Set() };
  for (const s of [e.before, e.after]) if (s) for (const p of s.paths) t.paths.add(p);
  const strict = STRICT.includes(e.undo);
  if (strict) t.allPaths = true;
  else if (e.treePaths) for (const p of e.treePaths) t.paths.add(p);
  else t.allPaths = recordable(e);
  for (const m of e.refs) t.writes.add(m.name);
  if (!sameHead(e.headBefore, e.headAfter)) t.writes.add('HEAD');
  for (const c of e.config) t.writes.add(`config:${c.key}`);
  if (e.stashes.length > 0) t.writes.add('refs/stash');
  if (strict || e.undo === 'switch' || e.undo === 'moveHead') {
    t.reads.add('HEAD');
    for (const b of [e.headBefore.branch, e.headAfter.branch]) if (b !== null) t.reads.add(`refs/heads/${b}`);
  }
  return t;
}

/** The first path of `a` (sorted) that is a path of `b`, a folder of one, or under one. */
export function firstOverlap(a: Set<string>, b: Set<string>): string | null {
  for (const p of sorted(a)) {
    if (b.has(p)) return p;
    for (const q of b) if (q.startsWith(`${p}/`)) return p;
    for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) if (b.has(p.slice(0, i))) return p;
  }
  return null;
}

function describe(name: string): string {
  if (name === 'HEAD') return 'A later action moved HEAD';
  if (name.startsWith('config:')) return `A later action changed ${name.slice('config:'.length)}`;
  if (name === 'refs/stash') return 'A later action changed the stash list';
  return `A later action moved ${shortRef(name)}`;
}

function conflict(older: Touched, newer: Touched, newerLabel: string): string | null {
  if ((older.allPaths && (newer.allPaths || newer.paths.size > 0)) || (newer.allPaths && older.paths.size > 0)) return `A later action changed the working tree (${newerLabel})`;
  const p = firstOverlap(older.paths, newer.paths);
  if (p !== null) return `A later action changed ${p}`;
  const hits = [...sorted(older.writes).filter((w) => newer.writes.has(w) || newer.reads.has(w)), ...sorted(newer.writes).filter((w) => older.reads.has(w))];
  const pick = hits.find((w) => w !== 'HEAD') ?? hits[0];
  return pick === undefined ? null : describe(pick);
}

function eligible(e: JournalEntry): string | null {
  const inOrder = 'Only Undo of the actions after it can reach this one';
  if (e.state !== 'done' || e.blocked !== null || e.undo === 'barrier' || e.paused !== null || e.stoppedPick !== null) return inOrder;
  if (e.indexBefore !== null || e.indexAfter !== null || e.stashes.length > 0) return inOrder;
  if (e.undo === 'restore' && e.before && e.after && e.refs.length === 0 && e.config.length === 0 && sameHead(e.headBefore, e.headAfter)) return null;
  if (e.undo === 'moveRefs' && !e.before && !e.after && (e.refs.length > 0 || e.config.length > 0)) return null;
  return inOrder;
}

function touchedNames(e: JournalEntry): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const s of [e.before, e.after]) if (s) s.paths.forEach(push);
  for (const p of e.treePaths ?? []) push(p);
  if (STRICT.includes(e.undo) || (recordable(e) && e.treePaths === null)) push('working tree');
  for (const m of e.refs) push(shortRef(m.name));
  if (e.headBefore.branch !== e.headAfter.branch || (e.headBefore.oid !== e.headAfter.oid && e.refs.length === 0)) push('HEAD');
  for (const c of e.config) push(c.key);
  if (e.stashes.length > 0) push('stash');
  return out;
}

const BANNER: Record<KeptReason['status'], BannerKind | null> = {
  pending: null, paused: null, refused: 'autostashRefused', conflicts: 'autostashConflicts', partialRestore: 'autostashPartial', stopped: 'autostashPartial', interrupted: 'recovery',
  abortedWork: 'abortedWork',
};

export class Journal {
  /** Oldest first; the last done one is what Undo undoes. */
  undo: JournalEntry[] = [];
  /** The last is what Redo redoes. */
  redo: JournalEntry[] = [];
  /** Stashes GitVolt made and still keeps (their banners). */
  kept: KeptStash[] = [];
  nextId = 1;

  private take(): number {
    const id = Math.max(this.nextId, 1);
    this.nextId = id + 1;
    return id;
  }

  begin(e: NewEntry, now: number): number {
    const id = this.take();
    this.undo.push(fresh(id, e, now));
    return id;
  }

  paused(): JournalEntry | null {
    for (let i = this.undo.length - 1; i >= 0; i--) if (this.undo[i].state === 'paused') return this.undo[i];
    return null;
  }

  /** The paused op completed (`moves`) or was aborted (none): done, or dropped when nothing changed. True when kept. */
  settle(id: number, headAfter: HeadState, moves: RefMove[]): boolean {
    const e = this.undo.find((x) => x.id === id && x.state === 'paused');
    if (!e) return false;
    e.headAfter = headAfter;
    e.refs = moves;
    e.paused = null;
    e.state = 'pending';
    return this.finalize(id);
  }

  /** A done Barrier just below the pending entry `id` (a push made by the same write). */
  barrierBefore(id: number, label: string, kind: OpKind, head: HeadState, now: number): number | null {
    const at = this.undo.findIndex((e) => e.id === id);
    if (at < 0) return null;
    const bid = this.take();
    const e = fresh(bid, { label, kind, headBefore: head, undo: 'barrier' }, now);
    e.state = 'done';
    this.undo.splice(at, 0, e);
    this.redo = [];
    return bid;
  }

  keep(k: Omit<KeptStash, 'id'>): number {
    const id = this.take();
    this.kept.push({ ...k, id });
    return id;
  }

  keptById(id: number): KeptStash | null {
    return this.kept.find((k) => k.id === id) ?? null;
  }

  /** The stash `oid` was popped or dropped from the stash menus: its kept record goes (an in-flight one stays). */
  forgetKeptStash(oid: string): boolean {
    const n = this.kept.length;
    this.kept = this.kept.filter((k) => k.oid !== oid || k.reason.status === 'pending' || k.reason.status === 'paused');
    return this.kept.length !== n;
  }

  entry(id: number): JournalEntry | null {
    return this.undo.find((e) => e.id === id) ?? this.redo.find((e) => e.id === id) ?? null;
  }

  /** Done, or dropped if nothing changed; a kept entry is a new operation: redo clears (unless `keepRedo`), the cap applies. */
  finalize(id: number, keepRedo = false): boolean {
    const i = this.undo.findIndex((e) => e.id === id);
    if (i < 0) return false;
    if (!changed(this.undo[i])) {
      this.undo.splice(i, 1);
      return false;
    }
    this.undo[i].state = 'done';
    if (!keepRedo) this.redo = [];
    cap(this.undo);
    return true;
  }

  below(id: number): JournalEntry | null {
    const at = this.undo.findIndex((e) => e.id === id);
    const prev = at > 0 ? this.undo[at - 1] : null;
    return prev?.state === 'done' ? prev : null;
  }

  /** A save on top of a save of the same file: `into` takes this one's `after`, this one goes; redo clears. */
  coalesce(id: number, into: number): boolean {
    const i = this.undo.findIndex((e) => e.id === id);
    const target = this.undo.find((e) => e.id === into);
    if (i < 0 || !target) return false;
    const [e] = this.undo.splice(i, 1);
    target.after = e.after;
    this.redo = [];
    return true;
  }

  dropEntry(id: number): void {
    this.undo = this.undo.filter((e) => e.id !== id);
    this.redo = this.redo.filter((e) => e.id !== id);
  }

  /** Drops `id` and every older undo entry (undo is linear); their labels. */
  dropThrough(id: number): string[] {
    const i = this.undo.findIndex((e) => e.id === id);
    return i < 0 ? [] : drainUnpaused(this.undo, i + 1).map((e) => e.label);
  }

  undoTop(): JournalEntry | null {
    for (let i = this.undo.length - 1; i >= 0; i--) if (this.undo[i].state === 'done') return this.undo[i];
    return null;
  }

  redoTop(): JournalEntry | null {
    return this.redo.at(-1) ?? null;
  }

  /** After an undo (`toRedo`) or a redo, the entry changes stacks; each keeps 50. */
  shift(id: number, toRedo: boolean): void {
    const from = toRedo ? this.undo : this.redo;
    const to = toRedo ? this.redo : this.undo;
    const i = from.findIndex((e) => e.id === id);
    if (i >= 0) to.push(...from.splice(i, 1));
    cap(this.undo);
    cap(this.redo);
  }

  /** `busy`: "merge", "rebase", … when the worktree is mid-operation. */
  state(busy: string | null): JournalState {
    const blockedBy = busy === null ? null : `Finish or abort the ${busy} first`;
    const top = this.undoTop();
    const undoBlocked = blockedBy ?? (top === null ? 'Nothing to undo' : top.undo === 'barrier' ? "Push can't be undone" : top.blocked);
    const redoBlocked = blockedBy ?? (this.redoTop() === null ? 'Nothing to redo' : null);
    const banners: Banner[] = [];
    for (const k of this.kept) {
      const kind = BANNER[k.reason.status];
      if (k.oid === null || kind === null) continue;
      const files = k.reason.status === 'conflicts' ? k.reason.files : 0;
      const binary = k.reason.status === 'conflicts' ? k.reason.binary : false;
      const stopped = k.reason.status === 'stopped' && k.reason.phase === 'push' ? 'autostashStopped' : kind;
      banners.push({ entry: k.id, kind: stopped, label: k.label, stash: k.oid, stashMessage: k.message, target: k.target, snapshot: false, files, canDrop: k.reason.status === 'conflicts', binary });
    }
    const p = this.paused();
    return {
      undo: top && { entry: top.id, label: top.label, kind: top.kind },
      redo: this.redoTop() && { entry: this.redoTop()!.id, label: this.redoTop()!.label, kind: this.redoTop()!.kind },
      undoBlocked,
      redoBlocked,
      banners,
      paused: p?.paused ? { entry: p.id, kind: p.paused.kind, label: p.label, target: p.paused.target, irebase: p.paused.irebase !== null } : null,
    };
  }

  private independent(at: number, except: number | null): string | null {
    const mine = touched(this.undo[at]);
    const not = eligible(this.undo[at]);
    if (not !== null) return not;
    if (typeof mine === 'string') return mine;
    for (const n of this.undo.slice(at + 1)) {
      if (n.id === except) continue;
      const theirs = touched(n);
      if (typeof theirs === 'string') return theirs;
      const why = conflict(mine, theirs, n.label);
      if (why !== null) return why;
    }
    return null;
  }

  /** The dropdown: the newest done entries, newest first; the first is what Undo undoes. */
  history(busy: string | null, undoBlocked: string | null): HistoryRow[] {
    const top = this.undoTop()?.id;
    const rows: HistoryRow[] = [];
    for (let i = this.undo.length - 1; i >= 0 && rows.length < HISTORY_ROWS; i--) {
      const e = this.undo[i];
      if (e.state !== 'done') continue;
      const blocked = e.id === top ? undoBlocked : busy !== null ? `Finish or abort the ${busy} first` : this.independent(i, null);
      rows.push({ entry: e.id, label: e.label, kind: e.kind, atMs: e.atMs, touched: touchedNames(e), blocked });
    }
    return rows;
  }

  /** The entry `id` if it can be undone out of order now. `except`: the out-of-order undo's own entry. */
  outOfOrder(id: number, except: number | null): { entry: JournalEntry } | { why: string } {
    const at = this.undo.findIndex((e) => e.id === id);
    if (at < 0) return { why: 'The undo history changed; refreshed' };
    const why = this.independent(at, except);
    return why === null ? { entry: this.undo[at] } : { why };
  }

  /** Every redo entry is independent of `target` (an out-of-order undo keeps the Redo stack then). */
  redoSurvives(target: JournalEntry): boolean {
    const mine = touched(target);
    if (typeof mine === 'string') return false;
    return this.redo.every((r) => {
      const theirs = touched(r);
      return typeof theirs !== 'string' && conflict(mine, theirs, r.label) === null && conflict(theirs, mine, target.label) === null;
    });
  }
}
