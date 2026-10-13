/**
 * Three-way conflict prediction: the paths a merge of two commits would leave unresolved, as the
 * core's in-memory merge (gix's `merge_commits`, unresolved as git counts them) reports them.
 * Written from that behaviour and checked only against the core and the `git` binary. Where it
 * can differ:
 * - the core's text merge places each side's changes with the indent heuristic (git's own merge
 *   doesn't, nor does `diffLines`), and either diff can keep other copies of repeated lines, so
 *   two edits a line or two apart can touch in the core and not here, or the reverse (about 1-2%
 *   of files both sides edit; the answer then is git's);
 * - renames are paired as `pairRenames` pairs them (git's similarity), not by gix's line-diff score;
 * - criss-cross histories merge from one merge base, not a virtual one;
 * - `.gitattributes` merge drivers (`merge=union`, `-merge`) aren't applied.
 */
import { compareBytewise, isBinaryHead, latin1 } from './bytes';
import { readCommit } from './commitText';
import { diffLines, splitLines, type Edit } from './lineDiff';
import { renamePairs } from './renames';
import { mergeBaseOf } from './revs';
import type { ReadRepo } from './seam';
import { diffTrees, MODE_GITLINK, MODE_LINK, modeType, readBlobBytes, type FileEntry, type TreeChange } from './trees';

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

interface SideEdit extends Edit {
  ours: boolean;
}

/** The lines one side makes of base lines [from, to), given its edits there (in order). */
function sideText(base: string[], lines: string[], edits: SideEdit[], from: number, to: number): string[] {
  const out: string[] = [];
  let at = from;
  for (const e of edits) {
    for (let i = at; i < e.oldStart; i++) out.push(base[i]);
    for (let i = e.newStart; i < e.newEnd; i++) out.push(lines[i]);
    at = e.oldEnd;
  }
  for (let i = at; i < to; i++) out.push(base[i]);
  return out;
}

/**
 * Whether a text merge leaves no conflict. Each side's edits against the base are taken in base
 * order; edits that overlap or touch (one starts where another ends, or both insert at one line)
 * form a group. A group holding edits of both sides conflicts unless both sides make the same
 * lines of its base span.
 */
export function mergeIsClean(base: string[], ours: string[], theirs: string[]): boolean {
  const edits: SideEdit[] = [];
  for (const e of diffLines(base, ours)) edits.push({ ...e, ours: true });
  for (const e of diffLines(base, theirs)) edits.push({ ...e, ours: false });
  edits.sort((x, y) => x.oldStart - y.oldStart);
  let i = 0;
  while (i < edits.length) {
    const from = edits[i].oldStart;
    let to = edits[i].oldEnd;
    let j = i + 1;
    while (j < edits.length && edits[j].oldStart <= to) to = Math.max(to, edits[j++].oldEnd);
    const group = edits.slice(i, j);
    i = j;
    const mine = group.filter((e) => e.ours);
    const yours = group.filter((e) => !e.ours);
    if (mine.length === 0 || yours.length === 0) continue;
    const a = sideText(base, ours, mine, from, to);
    const b = sideText(base, theirs, yours, from, to);
    if (a.length !== b.length || a.some((line, k) => line !== b[k])) return false;
  }
  return true;
}

const sameEntry = (a: FileEntry, b: FileEntry) => a.oid === b.oid && a.mode === b.mode;

/** One side's changes since the base, renames paired. */
interface Side {
  /** Each base file the side changed: its base entry, and where its content now is (null: deleted). */
  moved: Map<string, { base: FileEntry; now: { path: string; entry: FileEntry } | null }>;
  /** Each path the side added or renamed something to: the entry, and the base path it came from. */
  put: Map<string, { entry: FileEntry; from: string | null }>;
}

async function sideOf(repo: ReadRepo, baseTree: string, tree: string): Promise<Side> {
  const changes = await diffTrees(repo, baseTree, tree);
  // Empty files never pair as renames in the core (gix's `track_empty` is off).
  const pairable = (c: TreeChange) => (c.old && c.new) || (c.old ?? c.new)!.oid !== EMPTY_BLOB;
  const renamed = new Map((await renamePairs(repo, changes.filter(pairable))).map((p) => [p.from.path, p.to]));
  const renamedTo = new Set([...renamed.values()].map((f) => f.path));
  const side: Side = { moved: new Map(), put: new Map() };
  for (const c of changes) {
    if (c.old && c.new) side.moved.set(c.path, { base: c.old, now: { path: c.path, entry: c.new } });
    else if (c.old) {
      const to = renamed.get(c.path);
      side.moved.set(c.path, { base: c.old, now: to ? { path: to.path, entry: { oid: to.oid, mode: to.mode } } : null });
      if (to) side.put.set(to.path, { entry: { oid: to.oid, mode: to.mode }, from: c.path });
    } else if (c.new && !renamedTo.has(c.path)) side.put.set(c.path, { entry: c.new, from: null });
  }
  return side;
}

/** Both sides changed one file differently: whether merging the two leaves a conflict. `base` is
 *  null for two additions; a base of another kind merges as an empty one. */
async function contentConflict(repo: ReadRepo, base: FileEntry | null, ours: FileEntry, theirs: FileEntry): Promise<boolean> {
  const kind = modeType(ours.mode);
  if (kind === MODE_GITLINK || kind !== modeType(theirs.mode)) return true;
  // Same content: a base settles the executable bit; two additions that disagree on it conflict.
  if (ours.oid === theirs.oid) return base === null && ours.mode !== theirs.mode;
  if (kind === MODE_LINK) return true;
  const from = base && modeType(base.mode) === kind ? await readBlobBytes(repo, base.oid) : new Uint8Array();
  const [a, b] = [await readBlobBytes(repo, ours.oid), await readBlobBytes(repo, theirs.oid)];
  if (isBinaryHead(from) || isBinaryHead(a) || isBinaryHead(b)) return true;
  return !mergeIsClean(splitLines(latin1(from)), splitLines(latin1(a)), splitLines(latin1(b)));
}

/** The paths a side added or changed and still has. */
function* written(side: Side): Iterable<string> {
  yield* side.put.keys();
  for (const { now } of side.moved.values()) if (now) yield now.path;
}

/** Every folder above `paths`' files. */
function foldersOf(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) for (let at = p.indexOf('/'); at >= 0; at = p.indexOf('/', at + 1)) out.add(p.slice(0, at));
  return out;
}

/**
 * The core's `predicted_conflicts`: the paths a merge of `ours` and `theirs` would leave unresolved,
 * at ours' location, sorted bytewise. Nothing without a merge base. Conflicts: a file changed
 * differently on both sides whose contents don't merge (or that is binary, a symlink, a submodule,
 * or changed to different kinds of file); modified on one side and deleted on the other, a rename
 * against a deletion, a file renamed to two places, two different files added (or renamed) to one
 * path, and a file one side adds where the other adds a folder.
 */
export async function predictConflicts(repo: ReadRepo, ours: string, theirs: string): Promise<string[]> {
  const baseId = await mergeBaseOf(repo, ours, theirs);
  if (!baseId || baseId === ours || baseId === theirs) return [];
  const tree = async (id: string) => (await readCommit(repo, id)).tree;
  const baseTree = await tree(baseId);
  const mine = await sideOf(repo, baseTree, await tree(ours));
  const yours = await sideOf(repo, baseTree, await tree(theirs));
  const conflicts = new Set<string>();

  // Base files both sides changed.
  for (const [path, { base, now: o }] of mine.moved) {
    const other = yours.moved.get(path);
    if (!other) continue;
    const t = other.now;
    if (!o || !t) {
      if (o || t) conflicts.add(o ? o.path : path);
      continue;
    }
    if (o.path !== t.path && o.path !== path && t.path !== path) conflicts.add(o.path);
    else if (!sameEntry(o.entry, t.entry) && (await contentConflict(repo, base, o.entry, t.entry))) conflicts.add(o.path);
  }

  // Both sides added (or renamed different files) to one path.
  for (const [path, o] of mine.put) {
    const t = yours.put.get(path);
    if (!t || (o.from !== null && o.from === t.from) || sameEntry(o.entry, t.entry)) continue;
    if (await contentConflict(repo, null, o.entry, t.entry)) conflicts.add(path);
  }

  // A file one side adds where the other adds or changes files under a folder of that name. A file
  // renamed there isn't one: the core moves it aside and counts that resolved (git conflicts).
  const oursFolders = foldersOf(written(mine));
  const theirsFolders = foldersOf(written(yours));
  for (const [path, { from }] of mine.put) if (from === null && theirsFolders.has(path)) conflicts.add(path);
  for (const [path, { from }] of yours.put) if (from === null && oursFolders.has(path)) conflicts.add(path);
  return [...conflicts].sort(compareBytewise);
}

