/**
 * `git blame --porcelain <rev> -- <path>` (no `-M`/`-C` lines options: the core passes none), written
 * from how git behaves and checked only against the `git` binary.
 *
 * Every line of the file at `rev` starts blamed on `rev`. Commits are visited newest committer time
 * first; each visited commit hands the lines it blames to its parents where they came from there:
 * - a parent's version is the file at the same path when it's the same kind of file (a regular file
 *   or a symlink), and none when it's the other kind (a type change); else, when the parent has no
 *   file there (nothing, a folder or a gitlink), the file that commit deleted that `-M` pairs with
 *   the path (the path the only destination, so another added file never takes its source), or none;
 * - a parent with the very same blob takes every line: the first such parent at the same path, else
 *   the first such through a rename;
 * - otherwise the parents in order each take the lines the line diff keeps unchanged from them.
 * What no parent takes stays on the commit. A commit with no readable parent is a boundary.
 * Where it can differ from git: the line diff's known divergences (`lineDiff.ts`'s header: git's
 * indent heuristic, equal-cost paths), rename pairs within a point of 50% (`renames.ts`), and
 * `.mailmap`, which isn't applied to the authors.
 */
import type { BlameCommit } from '../../../api/gen/BlameCommit';
import type { BlameHunk } from '../../../api/gen/BlameHunk';
import type { BlamePayload } from '../../../api/gen/BlamePayload';
import { latin1 } from './bytes';
import { blameSummary, readCommit, readCommitOrNull, type ParsedCommit } from './commitText';
import { diffLines, splitLines } from './lineDiff';
import { DateQueue } from './logWalk';
import { pairRenames, type RenameFile } from './renames';
import { fail, type ReadRepo } from './seam';
import { diffTrees, entryAt, isTreeMode, MODE_GITLINK, modeType, readBlobBytes, type FileEntry } from './trees';

/** A commit's version of the blamed file. */
interface Suspect {
  commit: string;
  parsed: ParsedCommit;
  path: string;
  file: FileEntry;
  /** Loaded when first diffed; dropped once the suspect has passed its lines on. */
  lines: string[] | null;
  /** Lines waiting to be passed on, in no particular order. */
  waiting: Span[];
}

/** Lines [at, at + count) of a suspect's file, which are lines [final, final + count) of the blamed file (0-based). */
interface Span {
  final: number;
  at: number;
  count: number;
}

/** A blamed run of lines: the commit (and its path) that last changed them. */
export interface BlameRun extends Span {
  commit: string;
  parsed: ParsedCommit;
  path: string;
  /** The commit has no readable parent. */
  boundary: boolean;
}

/** Child lines [from, to) are parent lines [parentFrom, …): what the diff kept unchanged. */
interface Kept {
  from: number;
  to: number;
  parentFrom: number;
}

const usable = (e: FileEntry | null): e is FileEntry => e !== null && !isTreeMode(e.mode) && e.mode !== MODE_GITLINK;

function keptRuns(parent: string[], child: string[]): Kept[] {
  const out: Kept[] = [];
  let p = 0;
  let c = 0;
  for (const e of diffLines(parent, child)) {
    if (e.newStart > c) out.push({ from: c, to: e.newStart, parentFrom: p });
    p = e.oldEnd;
    c = e.newEnd;
  }
  if (c < child.length) out.push({ from: c, to: child.length, parentFrom: p });
  return out;
}

/**
 * `spans` cut along `kept`: the parts inside a kept run, renumbered to the parent, and the rest.
 * Spans can overlap (a line that reached the commit by two paths), so what's left of one can sit
 * after the next one's start: sort them each time.
 */
function cut(spans: Span[], kept: Kept[]): { taken: Span[]; left: Span[] } {
  const taken: Span[] = [];
  const left: Span[] = [];
  let k = 0;
  for (const s of [...spans].sort((x, y) => x.at - y.at)) {
    const end = s.at + s.count;
    let at = s.at;
    while (k < kept.length && kept[k].to <= at) k++;
    for (let r = k; r < kept.length && kept[r].from < end; r++) {
      const from = Math.max(at, kept[r].from);
      const to = Math.min(end, kept[r].to);
      if (from > at) left.push({ final: s.final + at - s.at, at, count: from - at });
      taken.push({ final: s.final + from - s.at, at: kept[r].parentFrom + from - kept[r].from, count: to - from });
      at = to;
    }
    if (at < end) left.push({ final: s.final + at - s.at, at, count: end - at });
  }
  return { taken, left };
}

/** Each line of `path` at `rev` (a commit id), as the runs of the commits that last changed them, in final-line order. */
export async function blameRuns(repo: ReadRepo, rev: string, path: string): Promise<BlameRun[]> {
  const top = await readCommit(repo, rev);
  const file = await entryAt(repo, top.tree, path);
  if (!usable(file)) fail('Other', `no such path ${path} in ${rev}`);

  const suspects = new Map<string, Map<string, Suspect>>(); // commit → path → suspect
  const queue = new DateQueue<string>();
  const queued = new Set<string>();
  const runs: BlameRun[] = [];

  const suspect = (commit: string, parsed: ParsedCommit, p: string, f: FileEntry): Suspect => {
    let byPath = suspects.get(commit);
    if (!byPath) suspects.set(commit, (byPath = new Map()));
    let s = byPath.get(p);
    if (!s) byPath.set(p, (s = { commit, parsed, path: p, file: f, lines: null, waiting: [] }));
    return s;
  };
  const linesOf = async (s: Suspect) => (s.lines ??= splitLines(latin1(await readBlobBytes(repo, s.file.oid))));
  const hand = (s: Suspect, spans: Span[]) => {
    if (spans.length === 0) return;
    s.waiting.push(...spans);
    if (queued.has(s.commit)) return;
    queued.add(s.commit);
    queue.push(s.commit, s.parsed.committer.time);
  };
  const blamed = (s: Suspect, spans: Span[], boundary: boolean) => {
    for (const sp of spans) runs.push({ ...sp, commit: s.commit, parsed: s.parsed, path: s.path, boundary });
  };
  /** `s`'s file in `parent`, or null (the parent unreadable too). */
  const inParent = async (s: Suspect, parentId: string, parent: ParsedCommit): Promise<Suspect | null> => {
    const same = await entryAt(repo, parent.tree, s.path);
    if (usable(same)) return modeType(same.mode) === modeType(s.file.mode) ? suspect(parentId, parent, s.path, same) : null;
    const asFile = (p: string, e: FileEntry): RenameFile => ({ path: p, oid: e.oid, mode: e.mode, load: () => readBlobBytes(repo, e.oid) });
    const deleted: RenameFile[] = [];
    for (const ch of await diffTrees(repo, parent.tree, s.parsed.tree)) if (ch.old && !ch.new && ch.old.mode !== MODE_GITLINK) deleted.push(asFile(ch.path, ch.old));
    if (deleted.length === 0) return null;
    const [pair] = await pairRenames(deleted, [asFile(s.path, s.file)]);
    return pair ? suspect(parentId, parent, pair.from.path, { oid: pair.from.oid, mode: pair.from.mode }) : null;
  };

  const first = suspect(rev, top, path, file);
  const length = (await linesOf(first)).length;
  hand(first, length > 0 ? [{ final: 0, at: 0, count: length }] : []);

  for (let commit = queue.pop(); commit !== undefined; commit = queue.pop()) {
    queued.delete(commit);
    for (const s of suspects.get(commit)!.values()) {
      if (s.waiting.length === 0) continue;
      const spans = s.waiting;
      s.waiting = [];
      const parents: Suspect[] = [];
      let readable = 0;
      for (const id of s.parsed.parents) {
        const parent = await readCommitOrNull(repo, id);
        if (!parent) continue;
        readable++;
        const ps = await inParent(s, id, parent);
        if (ps) parents.push(ps);
      }
      // One at the same path first, as git: a later parent's same file beats an earlier one's rename.
      const whole = parents.find((ps) => ps.file.oid === s.file.oid && ps.path === s.path) ?? parents.find((ps) => ps.file.oid === s.file.oid);
      if (whole) {
        hand(whole, spans);
        s.lines = null;
        continue;
      }
      let left = spans;
      for (const ps of parents) {
        if (left.length === 0) break;
        const split = cut(left, keptRuns(await linesOf(ps), await linesOf(s)));
        hand(ps, split.taken);
        left = split.left;
      }
      blamed(s, left, readable === 0);
      s.lines = null;
    }
  }

  runs.sort((x, y) => x.final - y.final);
  // git's coalescing: a run that continues the one before it in the same commit's file joins it.
  const out: BlameRun[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.commit === r.commit && prev.path === r.path && prev.at + prev.count === r.at && prev.final + prev.count === r.final) prev.count += r.count;
    else out.push({ ...r });
  }
  return out;
}

export async function blameFile(repo: ReadRepo, rev: string, path: string): Promise<BlamePayload> {
  const hunks: BlameHunk[] = [];
  const commits: BlameCommit[] = [];
  const seen = new Set<string>();
  for (const r of await blameRuns(repo, rev, path)) {
    hunks.push({ sha: r.commit, start: r.final + 1, lines: r.count });
    if (seen.has(r.commit)) continue;
    seen.add(r.commit);
    const c = r.parsed;
    commits.push({ sha: r.commit, author: c.author.name, email: c.author.email, time: c.author.time, summary: blameSummary(c.rawMessage, r.commit), boundary: r.boundary });
  }
  return { hunks, commits };
}
