/**
 * Rename detection as `git diff -M` behaves (the core runs `git diff-tree -M`), written from that
 * behaviour and checked only against the `git` binary: exact renames first (empty files too),
 * then file names unique on both sides at 75%, then each destination's best candidates at 50%.
 * Where it can differ: a pair within a point of 50% or 75% can land on the other side, ties among
 * equal scores may pair differently, and git's `diff.renameLimit` isn't applied.
 */
import { isBinaryHead } from './bytes';
import type { ReadRepo } from './seam';
import { MODE_FILE, MODE_GITLINK, modeType, readBlobBytes, type TreeChange } from './trees';

export const MAX_SCORE = 60_000;
export const MIN_SCORE = 30_000;
const BASENAME_SCORE = MIN_SCORE + (MAX_SCORE - MIN_SCORE) / 2;
const CANDIDATES_PER_DST = 4;
const CHUNK_BYTES = 64;

export interface RenameFile {
  path: string;
  oid: string;
  mode: number;
  load(): Promise<Uint8Array>;
}

export interface RenamePair {
  from: RenameFile;
  to: RenameFile;
  score: number;
}

/** A file's size and its distinct chunks: ids ascending, each with the bytes it holds in all its copies. */
interface Profile {
  size: number;
  ids: Uint32Array;
  bytes: Uint32Array;
}

/** Numbers chunks so that profiles compare by merging two sorted arrays. */
type Interner = Map<string, number>;

// Chunk keys only need one UTF-16 unit per byte, distinct for every byte. WHATWG's 'latin1' is
// windows-1252, which maps 0x80-0x9F elsewhere but still to 32 distinct units, CR and LF as
// themselves; it decodes several times faster than `latin1()`.
const byteChars = new TextDecoder('latin1');

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isRegular = (mode: number) => modeType(mode) === modeType(MODE_FILE);

function profile(data: Uint8Array, interner: Interner): Profile {
  let s = byteChars.decode(data);
  if (!isBinaryHead(data)) s = s.replaceAll('\r\n', '\n');
  const counts = new Map<number, number>();
  // `lineEnd` is just past the next newline (or the end): found once per line, not per chunk,
  // so a long line without newlines stays linear.
  let lineEnd = 0;
  for (let start = 0; start < s.length; ) {
    if (lineEnd <= start) {
      const nl = s.indexOf('\n', start);
      lineEnd = nl < 0 ? s.length : nl + 1;
    }
    const end = Math.min(lineEnd, start + CHUNK_BYTES);
    const chunk = s.slice(start, end);
    let id = interner.get(chunk);
    if (id === undefined) interner.set(chunk, (id = interner.size));
    counts.set(id, (counts.get(id) ?? 0) + end - start);
    start = end;
  }
  const ids = Uint32Array.from(counts.keys()).sort();
  return { size: data.length, ids, bytes: ids.map((id) => counts.get(id)!) };
}

// The shared bytes never exceed the smaller file, so a file more than twice the other's size
// can't reach MIN_SCORE: skip comparing its chunks.
const sizesAllow = (a: number, b: number) => Math.min(a, b) > 0 && Math.max(a, b) <= 2 * Math.min(a, b);

function score(a: Profile, b: Profile): number {
  if (!sizesAllow(a.size, b.size)) return 0;
  let shared = 0;
  for (let i = 0, j = 0; i < a.ids.length && j < b.ids.length; ) {
    if (a.ids[i] < b.ids[j]) i++;
    else if (a.ids[i] > b.ids[j]) j++;
    else shared += Math.min(a.bytes[i++], b.bytes[j++]);
  }
  return Math.floor((shared * MAX_SCORE) / Math.max(a.size, b.size));
}

export function similarity(src: Uint8Array, dst: Uint8Array): number {
  return similarityTo(dst)(src);
}

/** `similarity(src, dst)` for many sources against one `dst`, which is profiled once (on first use). */
export function similarityTo(dst: Uint8Array): (src: Uint8Array) => number {
  const interner: Interner = new Map();
  let target: Profile | null = null;
  return (src) => {
    if (!sizesAllow(src.length, dst.length)) return 0;
    target ??= profile(dst, interner);
    return score(profile(src, interner), target);
  };
}

export async function pairRenames(deleted: RenameFile[], added: RenameFile[]): Promise<RenamePair[]> {
  const pairs: RenamePair[] = [];
  const usedSrc = new Set<RenameFile>();
  const usedDst = new Set<RenameFile>();
  const pair = (from: RenameFile, to: RenameFile, score: number) => {
    pairs.push({ from, to, score });
    usedSrc.add(from);
    usedDst.add(to);
  };

  // 1. Exact renames: the same blob and kind of file, the same file name first.
  for (const to of added) {
    const same = deleted.filter((s) => !usedSrc.has(s) && s.oid === to.oid && modeType(s.mode) === modeType(to.mode));
    if (same.length === 0) continue;
    pair(same.find((s) => baseName(s.path) === baseName(to.path)) ?? same[0], to, MAX_SCORE);
  }

  // Loaded once, and only past the size check: most pairs of a large commit never get here.
  const interner: Interner = new Map();
  const profiles = new Map<RenameFile, Promise<Profile>>();
  const contents = new Map<RenameFile, Promise<Uint8Array>>();
  const bytesOf = (f: RenameFile) => {
    let b = contents.get(f);
    if (!b) contents.set(f, (b = f.load()));
    return b;
  };
  const profileOf = (f: RenameFile) => {
    let p = profiles.get(f);
    if (!p) profiles.set(f, (p = bytesOf(f).then((b) => profile(b, interner))));
    return p;
  };
  const similar = async (s: RenameFile, d: RenameFile) => {
    if (!isRegular(s.mode) || !isRegular(d.mode)) return 0;
    if (!sizesAllow((await bytesOf(s)).length, (await bytesOf(d)).length)) return 0;
    return score(await profileOf(s), await profileOf(d));
  };
  const srcs = () => deleted.filter((s) => !usedSrc.has(s));
  const dsts = () => added.filter((d) => !usedDst.has(d));

  // 2. A file name found once among the sources left and once among the destinations left.
  const byName = (files: RenameFile[]) => {
    const out = new Map<string, RenameFile[]>();
    for (const f of files) out.set(baseName(f.path), [...(out.get(baseName(f.path)) ?? []), f]);
    return out;
  };
  const srcNames = byName(srcs());
  for (const [name, ds] of byName(dsts())) {
    const ss = srcNames.get(name);
    if (ds.length !== 1 || ss?.length !== 1) continue;
    const sc = await similar(ss[0], ds[0]);
    if (sc >= BASENAME_SCORE) pair(ss[0], ds[0], sc);
  }

  // 3. Each destination keeps four candidate slots, filled in source order, every source scored
  // (below MIN_SCORE too, and 0 for the size check or a non-regular file). Once they're full, a
  // later source takes the weakest slot (the first of equals) only when strictly stronger, by
  // score and then a shared file name. The slots at MIN_SCORE or more are then paired greedily from
  // the strongest; equals keep the order they were collected in.
  const remainingSrc = srcs();
  const remainingDst = dsts();
  type Candidate = { s: RenameFile; d: RenameFile; score: number; sameName: boolean };
  const weaker = (x: Candidate, y: Candidate) => x.score < y.score || (x.score === y.score && !x.sameName && y.sameName);
  const candidates: Candidate[] = [];
  for (const d of remainingDst) {
    const slots: Candidate[] = [];
    for (const s of remainingSrc) {
      const sc = await similar(s, d);
      const c = { s, d, score: sc, sameName: baseName(s.path) === baseName(d.path) };
      if (slots.length < CANDIDATES_PER_DST) {
        slots.push(c);
        continue;
      }
      let weakest = 0;
      for (let i = 1; i < slots.length; i++) if (weaker(slots[i], slots[weakest])) weakest = i;
      if (weaker(slots[weakest], c)) slots[weakest] = c;
    }
    candidates.push(...slots.filter((c) => c.score >= MIN_SCORE));
  }
  candidates.sort((x, y) => y.score - x.score || Number(y.sameName) - Number(x.sameName));
  for (const { s, d, score } of candidates) if (!usedSrc.has(s) && !usedDst.has(d)) pair(s, d, score);
  return pairs;
}

/** The renames among `changes` (a `diffTrees` result: stored blobs on both sides), as `-M` finds them:
 *  deleted files paired with added ones; gitlinks never pair. */
export async function renamePairs(repo: ReadRepo, changes: TreeChange[]): Promise<RenamePair[]> {
  const file = (path: string, e: { oid: string; mode: number }): RenameFile => ({ path, oid: e.oid, mode: e.mode, load: () => readBlobBytes(repo, e.oid) });
  const deleted = changes.filter((c) => c.old && !c.new && c.old.mode !== MODE_GITLINK).map((c) => file(c.path, c.old!));
  const added = changes.filter((c) => !c.old && c.new && c.new.mode !== MODE_GITLINK).map((c) => file(c.path, c.new!));
  return deleted.length === 0 || added.length === 0 ? [] : pairRenames(deleted, added);
}
