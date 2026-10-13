/**
 * The three `git log` walks the core runs, written from how git behaves (checked against the `git`
 * binary only): `--follow -M -- <path>` (File History), `-- <pathspec>` with git's default history
 * simplification ("Search older history" by path), and `-i -F --grep` (by message).
 *
 * All three pop commits newest committer time first (ties in the order they were queued), queue
 * each commit once, and queue a commit's parents when it is popped; `max` counts the commits listed,
 * so a walk stops as soon as its page is full.
 */
import type { FileHistoryRow } from '../../../api/gen/FileHistoryRow';
import { asciiLower, MAX_FORCED_BYTES } from './bytes';
import { gitSubject, readCommitOrNull, type ParsedCommit } from './commitText';
import { MIN_SCORE, similarityTo } from './renames';
import type { ReadRepo } from './seam';
import { diffTrees, entryAt, isTreeMode, listFiles, MODE_FILE, MODE_GITLINK, modeType, readBlobBytes, type FileEntry } from './trees';

/** Newest first by time; equal times in the order they were queued. A binary heap. */
export class DateQueue<T> {
  private items: { item: T; time: number; order: number }[] = [];
  private queued = 0;

  get size(): number {
    return this.items.length;
  }

  push(item: T, time: number): void {
    const a = this.items;
    a.push({ item, time, order: this.queued++ });
    for (let i = a.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (!this.first(i, up)) break;
      this.swap(i, up);
      i = up;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0].item;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let pick = i;
        for (const child of [2 * i + 1, 2 * i + 2]) if (child < a.length && this.first(child, pick)) pick = child;
        if (pick === i) break;
        this.swap(i, pick);
        i = pick;
      }
    }
    return top;
  }

  /** Whether slot `x` comes out before slot `y`. */
  private first(x: number, y: number): boolean {
    const a = this.items[x];
    const b = this.items[y];
    return a.time !== b.time ? a.time > b.time : a.order < b.order;
  }

  private swap(x: number, y: number): void {
    [this.items[x], this.items[y]] = [this.items[y], this.items[x]];
  }
}

interface Visit {
  id: string;
  commit: ParsedCommit;
}

/** The date-ordered walk over `tips`. A commit that can't be read (a shallow clone's edge) is never
 *  queued; `parentsOf` drops such parents too, so the commit above one walks like a root. */
class Walk {
  private queue = new DateQueue<Visit>();
  private queued = new Set<string>();
  private repo: ReadRepo;

  constructor(repo: ReadRepo) {
    this.repo = repo;
  }

  async add(id: string): Promise<void> {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    const commit = await readCommitOrNull(this.repo, id);
    if (commit) this.queue.push({ id, commit }, commit.committer.time);
  }

  async addAll(ids: string[]): Promise<void> {
    for (const id of ids) await this.add(id);
  }

  next(): Visit | undefined {
    return this.queue.pop();
  }

  async parentsOf(c: ParsedCommit): Promise<{ id: string; commit: ParsedCommit }[]> {
    const out: { id: string; commit: ParsedCommit }[] = [];
    for (const id of c.parents) {
      const commit = await readCommitOrNull(this.repo, id);
      if (commit) out.push({ id, commit });
    }
    return out;
  }
}

/** The file (not a folder) at `path` in `tree`, or null. */
async function fileIn(repo: ReadRepo, tree: string | null, path: string): Promise<FileEntry | null> {
  if (tree === null) return null;
  const e = await entryAt(repo, tree, path);
  return e && !isTreeMode(e.mode) ? e : null;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Where `--follow` says the file added at `path` came from, as git 2.53 behaves (`path` is the only
 * destination; the other files that commit added never compete):
 * 1. a file in the parent with the same blob and kind of file: one with the same file name first,
 *    then one the commit deleted (`R`), then any other (`C`), each in path order;
 * 2. else the deleted file most similar to it (`R`), at 50% or more;
 * 3. else the most similar other file of the parent, modified or not, as it was there (`C`).
 * Ties in 2 and 3 go to the same file name, then path order. Unlike plain `-M`, no step pairs unique
 * file names first (`renamePairs` does, so it isn't used here). Steps 2 and 3 skip blobs over the
 * core's 64 MiB ceiling (git would score them). They read every file of the parent, but run only
 * where the followed path appears.
 */
export async function renameSource(repo: ReadRepo, fromTree: string | null, toTree: string, path: string): Promise<{ from: string; status: 'R' | 'C' } | null> {
  if (fromTree === null) return null;
  const dst = await fileIn(repo, toTree, path);
  if (!dst || dst.mode === MODE_GITLINK) return null;
  const deleted = new Set((await diffTrees(repo, fromTree, toTree)).filter((c) => c.old && !c.new).map((c) => c.path));
  const sources: { path: string; entry: FileEntry; deleted: boolean }[] = [];
  for (const [p, entry] of await listFiles(repo, fromTree)) if (entry.mode !== MODE_GITLINK && p !== path) sources.push({ path: p, entry, deleted: deleted.has(p) });
  const ordered = [...sources.filter((s) => s.deleted), ...sources.filter((s) => !s.deleted)];
  const found = (s: { path: string; deleted: boolean }) => ({ from: s.path, status: s.deleted ? ('R' as const) : ('C' as const) });

  const exact = ordered.filter((s) => s.entry.oid === dst.oid && modeType(s.entry.mode) === modeType(dst.mode));
  if (exact.length > 0) return found(exact.find((s) => baseName(s.path) === baseName(path)) ?? exact[0]);

  if (modeType(dst.mode) !== modeType(MODE_FILE)) return null;
  const target = await readBlobBytes(repo, dst.oid);
  if (target.length > MAX_FORCED_BYTES) return null;
  const similarity = similarityTo(target);
  for (const group of [ordered.filter((s) => s.deleted), ordered.filter((s) => !s.deleted)]) {
    let best: { s: (typeof group)[number]; score: number; sameName: boolean } | null = null;
    for (const s of group) {
      if (modeType(s.entry.mode) !== modeType(MODE_FILE)) continue;
      const bytes = await readBlobBytes(repo, s.entry.oid);
      if (bytes.length > MAX_FORCED_BYTES) continue;
      const score = similarity(bytes);
      const sameName = baseName(s.path) === baseName(path);
      if (score >= MIN_SCORE && (!best || score > best.score || (score === best.score && sameName && !best.sameName))) best = { s, score, sameName };
    }
    if (best) return found(best.s);
  }
  return null;
}

/** `git log --follow -M <start> -- <path>`: every parent walked (no simplification), merges never
 *  listed, and once a rename or copy is found the walk follows the source's path for every older commit. */
export async function followLog(repo: ReadRepo, start: string, path: string, max: number): Promise<FileHistoryRow[]> {
  const rows: FileHistoryRow[] = [];
  const walk = new Walk(repo);
  await walk.add(start);
  let followed = path;
  for (let v = walk.next(); v && rows.length < max; v = walk.next()) {
    const c = v.commit;
    await walk.addAll(c.parents);
    if (c.parents.length > 1) continue;
    const [parent] = await walk.parentsOf(c);
    const parentTree = parent?.commit.tree ?? null;
    const now = await fileIn(repo, c.tree, followed);
    const before = await fileIn(repo, parentTree, followed);
    if (!now && !before) continue;
    if (now && before && now.oid === before.oid && now.mode === before.mode) continue;
    let status = 'D';
    let oldPath: string | null = null;
    if (now && before) {
      status = modeType(now.mode) === modeType(before.mode) ? 'M' : 'T';
    } else if (now) {
      const source = await renameSource(repo, parentTree, c.tree, followed);
      oldPath = source?.from ?? null;
      status = source?.status ?? 'A';
    }
    rows.push({ sha: v.id, parents: c.parents, author: c.author.name, email: c.author.email, time: c.author.time, summary: gitSubject(c.rawMessage), path: followed, status, oldPath });
    if (oldPath !== null) followed = oldPath;
  }
  return rows;
}

/** `git log <tips> -- <pathspec>` (`match` is the pathspec) with git's default simplification: a
 *  commit is listed when a matching file differs from its parent (a root: when it has one); a merge
 *  that some parent is TREESAME to (no matching file differs) follows only the first such parent and
 *  isn't listed; a merge no parent is TREESAME to is listed and follows them all. */
export async function pathLog(repo: ReadRepo, tips: string[], match: (path: string) => boolean, max: number): Promise<string[]> {
  const out: string[] = [];
  const walk = new Walk(repo);
  await walk.addAll(tips);
  const treesame = async (from: string, to: string) => !(await diffTrees(repo, from, to)).some((ch) => match(ch.path));
  for (let v = walk.next(); v && out.length < max; v = walk.next()) {
    const c = v.commit;
    const parents = await walk.parentsOf(c);
    if (parents.length === 0) {
      for (const p of (await listFiles(repo, c.tree)).keys()) {
        if (match(p)) {
          out.push(v.id);
          break;
        }
      }
      continue;
    }
    if (parents.length === 1) {
      await walk.add(parents[0].id);
      if (!(await treesame(parents[0].commit.tree, c.tree))) out.push(v.id);
      continue;
    }
    let same: string | null = null;
    for (const p of parents) {
      if (await treesame(p.commit.tree, c.tree)) {
        same = p.id;
        break;
      }
    }
    if (same !== null) {
      await walk.add(same);
      continue;
    }
    await walk.addAll(parents.map((p) => p.id));
    out.push(v.id);
  }
  return out;
}

/** `git log <tips> -i -F --grep=<query>` as the core runs it (`LC_ALL=C`): every commit, listed when
 *  its message contains `query` with ASCII letters case-folded (other letters must match exactly). */
export async function messageLog(repo: ReadRepo, tips: string[], query: string, max: number): Promise<string[]> {
  const out: string[] = [];
  const needle = asciiLower(query);
  const walk = new Walk(repo);
  await walk.addAll(tips);
  for (let v = walk.next(); v && out.length < max; v = walk.next()) {
    await walk.addAll(v.commit.parents);
    if (asciiLower(v.commit.rawMessage).includes(needle)) out.push(v.id);
  }
  return out;
}
