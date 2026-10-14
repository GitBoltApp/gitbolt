// What an Abort of GitVolt's interactive rebase keeps of the work done at its stops (the core's
// write/irebase/split.rs `keep_work`, UX N: only what can't be had again): the commits holding new
// work on `<branch>-rebase-work`, the index's and the worktree's new content in a stash, with the
// "work from the stop" banner. What the step left at its stop (`noteStop`: a merge result git
// staged, a conflicted file's markers) is git's, never kept while it's still exactly that.
import { compareBytewise } from '../read/bytes';
import { readCommit } from '../read/commitText';
import { demoOf, lstatOrNull, type ReadRepo } from '../read/seam';
import { listFiles, diffTrees, type FileEntry } from '../read/trees';
import { worktreeFile } from '../read/worktree';
import {
  authorKey, keepAbortedWork, pausedAutostash, readIndexEntries, shortRef, statusEntries, writeBlobBytes, writeCommitObject, writeTreeOf,
  type IrebasePause, type WriteCx,
} from '../writeSeam';
import { gitFailure } from '../errors';
import { trimEndRust } from '../objects';
import { isAncestor, rangeCommits } from './range';
import { replay, treeOf } from './replay';
import type { SeqState, Stop } from './state';

/** A path's content in a tree, the index or the worktree: its kind (a file 0, an executable 1, a
 *  link 2, a submodule 3, a tree 4) and object, as `<kind> <oid>`; null: absent. */
type State = string | null;
const kindOf = (mode: number) => ((mode & 0o170000) === 0o120000 ? 2 : (mode & 0o170000) === 0o160000 ? 3 : (mode & 0o170000) === 0o040000 ? 4 : mode & 0o111 ? 1 : 0);
const stateOf = (e: FileEntry | null | undefined): State => (e ? `${kindOf(e.mode)} ${e.oid}` : null);
const MODES = [0o100644, 0o100755, 0o120000, 0o160000, 0o040000];

/** A path of the index: its stage-0 content, or conflicted. */
type Side = { staged: State } | 'unmerged';

async function indexSides(cx: WriteCx, paths: Set<string>): Promise<Map<string, Side>> {
  const out = new Map<string, Side>([...paths].map((p) => [p, { staged: null }]));
  for (const e of await readIndexEntries(cx.read, cx.gitdir)) {
    if (!out.has(e.path)) continue;
    out.set(e.path, e.stage === 0 ? { staged: stateOf(e) } : 'unmerged');
  }
  return out;
}

/** The worktree's side, as `git add` would store it (its blob written); a folder is a submodule:
 *  its commit is the index's. */
async function worktreeStates(cx: WriteCx, paths: Set<string>, index: Map<string, Side>): Promise<Map<string, State>> {
  const out = new Map<string, State>();
  for (const p of paths) {
    const st = await lstatOrNull(cx.read, `${cx.root}/${p}`);
    if (st?.isDirectory()) {
      const side = index.get(p);
      out.set(p, side && side !== 'unmerged' ? side.staged : null);
      continue;
    }
    const f = await worktreeFile(cx.read, cx.root, p);
    out.set(p, f === null ? null : `${kindOf(f.mode)} ${await writeBlobBytes(cx.read, f.bytes)}`);
  }
  return out;
}

/** UX N (the core's `note_stop`): at a stop the step just made, what it left there: a staged path's
 *  index, a conflicted path's worktree file. */
export async function noteStop(cx: WriteCx): Promise<[string, State][]> {
  const staged = new Set<string>();
  const unmerged = new Set<string>();
  for (const e of await statusEntries(cx.read, cx.root)) {
    if (e.kind === 'unmerged') unmerged.add(e.path);
    else if ((e.kind === 'ordinary' || e.kind === 'renamed') && e.index !== '.') {
      staged.add(e.path);
      if (e.origPath !== null) staged.add(e.origPath);
    }
  }
  const out: [string, State][] = [];
  for (const [p, side] of await indexSides(cx, staged)) if (side !== 'unmerged') out.push([p, side.staged]);
  for (const [p, s] of await worktreeStates(cx, unmerged, new Map())) out.push([p, s]);
  return out;
}

/** Each tree's files, read once. */
class Trees {
  private files = new Map<string, Map<string, FileEntry>>();
  private read: ReadRepo;
  constructor(read: ReadRepo) {
    this.read = read;
  }
  async at(tree: string, path: string): Promise<State> {
    let f = this.files.get(tree);
    if (!f) this.files.set(tree, (f = await listFiles(this.read, tree)));
    return stateOf(f.get(path));
  }
  /** The `changes` no tree of `trees` has at their path. */
  async notIn(trees: Iterable<string>, changes: [string, State][]): Promise<[string, State][]> {
    const left: [string, State][] = [];
    const all = [...trees];
    for (const [p, s] of changes) {
      let found = false;
      for (const t of all) if ((found = (await this.at(t, p)) === s)) break;
      if (!found) left.push([p, s]);
    }
    return left;
  }
}

interface Commit { oid: string; parent: string | null }

/** The core's `Sources`: the trees a path's content can be had from again, the commits made at the
 *  stops (with whether their message is none of the picks'), the replays with the picks they may
 *  replay (by author and time), and the trees of orig-head's history. */
async function sources(cx: WriteCx, s: SeqState, head: string, editStop: string | null, stoppedAt: string | null, made: string[]) {
  const read = cx.read;
  const tree = (c: string) => treeOf(read, c);
  const trees = new Set<string>();
  for (const c of [s.origHead, editStop, stoppedAt, head]) if (c) trees.add(await tree(c));
  const autostash = pausedAutostash(cx);
  if (autostash !== null) {
    const a = await readCommit(read, autostash);
    trees.add(a.tree);
    for (const p of a.parents.slice(1)) trees.add(await tree(p));
  }
  const picks = new Map<string, Commit[]>();
  const messages = new Set<string>();
  const history = new Set<string>();
  const msg = (raw: string) => trimEndRust(raw);
  for (const c of await rangeCommits(read, s.origHead, s.onto)) {
    const parsed = await readCommit(read, c.oid);
    const key = await authorKey(read, c.oid);
    picks.set(key, [...(picks.get(key) ?? []), { oid: c.oid, parent: c.parents[0] ?? null }]);
    messages.add(msg(parsed.rawMessage));
    history.add(parsed.tree);
    for (const p of c.parents) history.add(await tree(p));
  }
  for (const c of [s.onto, editStop, stoppedAt]) if (c) history.add(await tree(c));
  // A commit off the stop's commit is made there too, unless HEAD is only below it.
  const offStop = async (c: string) => editStop !== null && !(await isAncestor(read, c, editStop));
  const madeHere: [Commit, boolean][] = [];
  const replays: [Commit, Commit[]][] = [];
  for (const c of await rangeCommits(read, head, s.onto)) {
    const commit = { oid: c.oid, parent: c.parents[0] ?? null };
    const of = picks.get(await authorKey(read, c.oid));
    if (made.includes(c.oid) || of === undefined || (await offStop(c.oid))) madeHere.push([commit, !messages.has(msg((await readCommit(read, c.oid)).rawMessage))]);
    else replays.push([commit, of]);
  }
  return { trees, history, made: madeHere, replays };
}

async function changesOf(read: ReadRepo, c: Commit): Promise<[string, State][]> {
  return (await diffTrees(read, c.parent === null ? null : await treeOf(read, c.parent), await treeOf(read, c.oid))).map((ch) => [ch.path, stateOf(ch.new)]);
}

/** The core's `new_work_in_commits`: a commit made at a stop with a message of its own, or content
 *  found nowhere in orig-head's history; a replay with such content that its pick's own merge onto
 *  the replay's parent doesn't have either (a conflict resolved by hand at an earlier stop). */
async function newWorkInCommits(cx: WriteCx, src: Awaited<ReturnType<typeof sources>>, trees: Trees): Promise<boolean> {
  if (src.made.some(([, own]) => own)) return true;
  for (const [c] of src.made) if ((await trees.notIn(src.history, await changesOf(cx.read, c))).length > 0) return true;
  for (const [c, picks] of src.replays) {
    let left = await trees.notIn(src.history, await changesOf(cx.read, c));
    for (const p of picks) {
      if (left.length === 0) break;
      if (c.parent === null || p.parent === null) continue;
      const merged = await replay(cx.read, p.oid, await treeOf(cx.read, c.parent), 'pick');
      // A conflicted merge has no tree here (git's would hold the markers): the content is kept.
      if (merged.tree !== null) left = await trees.notIn([merged.tree], left);
    }
    if (left.length > 0) return true;
  }
  return false;
}

/** `base`'s tree with `entries` set (null: removed). */
async function treeWith(read: ReadRepo, base: string, entries: [string, State][]): Promise<string> {
  const files = new Map([...(await listFiles(read, base))].map(([p, e]) => [p, { path: p, mode: e.mode, oid: e.oid }]));
  for (const [p, s] of entries) {
    if (s === null) files.delete(p);
    else {
      const [kind, oid] = s.split(' ');
      files.set(p, { path: p, mode: MODES[Number(kind)], oid });
    }
  }
  return writeTreeOf(read, files.values());
}

/** `<branch>-rebase-work` at `head` (`-2`, `-3`… when that name, or one below it, is taken: a
 *  failed create tries the next one, as the core's `work_branch`). */
async function workBranch(cx: WriteCx, branch: string, head: string): Promise<string> {
  let last: unknown = null;
  for (let n = 1; n <= 20; n++) {
    const name = n === 1 ? `${branch}-rebase-work` : `${branch}-rebase-work-${n}`;
    try {
      await cx.cas([{ name: `refs/heads/${name}`, old: null, new: head }], 'rebase: keep the commits made at the stop');
      cx.touch('refs');
      return name;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? gitFailure('no free name for the work branch', '');
}

/** Before a rebase's Abort: git's reset back to orig-head refuses over an untracked file at a path
 *  orig-head has, whatever it holds (the binary, 2.53), and changes nothing. In GitVolt's session
 *  (the core's `clear_leftovers`) a file holding exactly orig-head's content there is the stop's
 *  commit's own, left unstaged: it goes first, and the reset writes it back. */
export async function clearLeftovers(cx: WriteCx, origHead: string, session: boolean): Promise<void> {
  const untracked = (await statusEntries(cx.read, cx.root)).filter((e) => e.kind === 'untracked').map((e) => e.path);
  if (untracked.length === 0) return;
  const target = await listFiles(cx.read, origHead);
  const gone: string[] = [];
  const blocked: string[] = [];
  for (const p of untracked.filter((u) => target.has(u)).sort(compareBytewise)) {
    const e = target.get(p)!;
    if (session && (e.mode === 0o100644 || e.mode === 0o100755) && (await lstatOrNull(cx.read, `${cx.root}/${p}`))?.isFile() && (await worktreeFile(cx.read, cx.root, p))?.oid === e.oid) gone.push(p);
    else blocked.push(p);
  }
  if (blocked.length > 0) {
    const first = 'The following untracked working tree files would be overwritten by reset:';
    throw gitFailure(first, `error: ${first}\n${blocked.map((p) => `\t${p}\n`).join('')}Please move or remove them before you reset.\nAborting\nfatal: could not move back to ${origHead}\n`);
  }
  const fs = demoOf(cx.read).fs;
  for (const p of gone) fs.unlinkSync(`${cx.root}/${p}`);
}

export interface KeptWork { stash: string | null; branch: string | null; record: { oid: string; message: string; label: string; target: string | null } | null }

/** Before an Abort of GitVolt's interactive rebase (`session`: its paused entry's): the work done at
 *  its stops, kept. The stash's banner is written once the abort ran (`finishKeptWork`). */
export async function keepWork(cx: WriteCx, s: SeqState, head: string, session: IrebasePause): Promise<KeptWork> {
  const w: KeptWork = { stash: null, branch: null, record: null };
  const read = cx.read;
  const stop: Stop | null = s.stop;
  const short = shortRef(s.headName ?? 'HEAD');
  // As InProgress reads them: the Edit stop's commit (or, at a fold's conflict, HEAD), and the commit being applied.
  const atFold = stop?.reason === 'conflict' && s.done.at(-1)?.op === 'fold';
  const editStop = stop?.reason === 'edit' ? (stop.made ?? null) : atFold ? s.head : null;
  const stoppedAt = stop?.at || null;
  const src = await sources(cx, s, head, editStop, stoppedAt, session.made);
  const trees = new Trees(read);
  // Commits.
  if (await newWorkInCommits(cx, src, trees)) w.branch = await workBranch(cx, short, head);
  // Edits: only the paths whose content (either side) can't be had again.
  const paths = new Set<string>();
  for (const e of await statusEntries(read, cx.root)) {
    if (e.kind !== 'ordinary' && e.kind !== 'renamed' && e.kind !== 'unmerged') continue;
    paths.add(e.path);
    if (e.origPath !== null) paths.add(e.origPath);
  }
  if (paths.size === 0) return w;
  const index = await indexSides(cx, paths);
  const worktree = await worktreeStates(cx, paths, index);
  const left = new Map<string, State[]>();
  for (const [p, st] of stop?.left ?? []) left.set(p, [...(left.get(p) ?? []), st]);
  const isNew = async (p: string, st: State) => (await trees.notIn(src.trees, [[p, st]])).length > 0 && !(left.get(p) ?? []).includes(st);
  const worth: string[] = [];
  for (const p of [...paths].sort(compareBytewise)) {
    const side = index.get(p)!;
    if ((side !== 'unmerged' && (await isNew(p, side.staged))) || (await isNew(p, worktree.get(p) ?? null))) worth.push(p);
  }
  if (worth.length === 0) return w;
  const staged = worth.flatMap((p): [string, State][] => {
    const side = index.get(p)!;
    return side === 'unmerged' ? [] : [[p, side.staged]];
  });
  const itree = await treeWith(read, head, staged);
  const wtree = await treeWith(read, head, worth.map((p): [string, State] => [p, worktree.get(p) ?? null]));
  const message = `GitVolt: work from the aborted rebase of ${short}`;
  // `git commit-tree -m`, as the visitor.
  const i = await writeCommitObject(read, { tree: itree, parents: [head], message: `index on ${short}\n` }, cx.ctx);
  const created = await writeCommitObject(read, { tree: wtree, parents: [head, i], message: `${message}\n` }, cx.ctx);
  w.stash = created;
  w.record = { oid: created, message, label: `abort the rebase of ${short}`, target: w.branch };
  return w;
}

/** After the Abort ran: the stash listed, with its "work from the stop" banner. */
export function finishKeptWork(cx: WriteCx, w: KeptWork): void {
  if (w.record !== null) keepAbortedWork(cx, w.record);
}
