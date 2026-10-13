/**
 * Changed-file lists: the core's `diff.rs` (`file_list`, `wip_lists`), with what it reads from
 * `git diff-tree -r -M` and `git diff [--cached] [-M]` (`-z --raw --numstat`) computed here. The git
 * behaviours ported below were checked against git 2.53 on scratch repositories.
 */
import type { BlobSource } from '../../../api/gen/BlobSource';
import type { ConflictKind } from '../../../api/gen/ConflictKind';
import type { FileChange } from '../../../api/gen/FileChange';
import type { FileListPayload } from '../../../api/gen/FileListPayload';
import type { SubmoduleState } from '../../../api/gen/SubmoduleState';
import { AttrReader, binaryByAttr } from './attributes';
import { compareBytewise, isBinaryHead, LARGE_FILE_BYTES, latin1, utf8Bytes } from './bytes';
import { indexMtime, readIndex, type IndexEntry } from './indexFile';
import { countEdits, diffLines, splitLines } from './lineDiff';
import { pairRenames, type RenameFile } from './renames';
import { diffTrees, listFiles, MODE_EXEC, MODE_FILE, MODE_GITLINK, modeType, readBlobBytes, readRaw, type FileEntry } from './trees';
import { isGbError, lstatOrNull, subRepo, type ReadRepo } from './seam';
import { nestedGitdir, nestedHead, unchangedSinceIndex, untrackedFiles, worktreeFile, type WorktreeFile } from './worktree';
import { worktreeOf } from './worktrees';

/** One side of a changed file. `stored`: the blob is in the object database (else it's a worktree file). */
export interface Content {
  mode: number;
  oid: string;
  stored: boolean;
  load(): Promise<Uint8Array>;
}

interface Row {
  status: string;
  path: string;
  oldPath: string | null;
  old: Content | null;
  new: Content | null;
  conflict?: ConflictKind;
  submoduleState?: SubmoduleState;
  /** Set when git's counts don't come from diffing the two sides (conflicts, a dirty submodule). */
  counts?: [number, number] | null;
}

const gitlinkText = (oid: string) => utf8Bytes(`Subproject commit ${oid}\n`);

function stored(repo: ReadRepo, e: FileEntry): Content {
  return { mode: e.mode, oid: e.oid, stored: true, load: async () => (e.mode === MODE_GITLINK ? gitlinkText(e.oid) : readBlobBytes(repo, e.oid)) };
}

function inWorktree(f: WorktreeFile): Content {
  return { mode: f.mode, oid: f.oid, stored: false, load: async () => f.bytes };
}

function checkedOut(oid: string): Content {
  return { mode: MODE_GITLINK, oid, stored: false, load: async () => gitlinkText(oid) };
}

type Side = { oid: string; mode: number } | null | undefined;
const same = (a: Side, b: Side) => !!a && !!b && a.oid === b.oid && a.mode === b.mode;

function statusOf(old: { mode: number } | null, now: { mode: number } | null): string {
  if (!old) return 'A';
  if (!now) return 'D';
  return modeType(old.mode) !== modeType(now.mode) ? 'T' : 'M';
}

const byPath = (a: Row, b: Row) => compareBytewise(a.path, b.path);

/** A tracked path's worktree file; null when it's gone (or reached through a link leaving the worktree). */
async function trackedFile(repo: ReadRepo, root: string, path: string): Promise<WorktreeFile | null> {
  try {
    return await worktreeFile(repo, root, path);
  } catch (e) {
    if (isGbError(e) && e.kind === 'InvalidInput') return null;
    throw e;
  }
}

/** `-M`: deleted and added files paired by `pairRenames` (gitlinks never pair); each pair becomes one `R`
 *  row at the added path. `rows` must be sorted. */
async function withRenames(rows: Row[]): Promise<Row[]> {
  const deleted = rows.filter((r) => r.status === 'D' && r.old!.mode !== MODE_GITLINK);
  const added = rows.filter((r) => r.status === 'A' && r.new!.mode !== MODE_GITLINK);
  if (deleted.length === 0 || added.length === 0) return rows;
  const asFile = (r: Row, c: Content): RenameFile => ({ path: r.path, oid: c.oid, mode: c.mode, load: () => c.load() });
  const pairs = await pairRenames(
    deleted.map((r) => asFile(r, r.old!)),
    added.map((r) => asFile(r, r.new!)),
  );
  if (pairs.length === 0) return rows;
  const fromOf = new Map(pairs.map((p) => [p.to.path, p.from.path]));
  const paired = new Set(pairs.map((p) => p.from.path));
  const gone = new Map(deleted.filter((r) => paired.has(r.path)).map((r) => [r.path, r]));
  const out: Row[] = [];
  for (const r of rows) {
    if (r.status === 'D' && gone.has(r.path)) continue;
    const from = r.status === 'A' ? fromOf.get(r.path) : undefined;
    if (from === undefined) out.push(r);
    else out.push({ status: 'R', path: r.path, oldPath: from, old: gone.get(from)!.old, new: r.new });
  }
  return out;
}

/** git's rename pass (on whenever there are both deleted and added paths) hashes each added path's
 *  worktree bytes, and the core then names that side by its blob when the blob is already stored. */
async function hashAddedSides(repo: ReadRepo, rows: Row[]): Promise<void> {
  if (!rows.some((r) => r.old && !r.new)) return;
  for (const r of rows) {
    const c = r.new;
    if (r.old || !c || c.stored || c.mode === MODE_GITLINK) continue;
    if ((await readRaw(repo, c.oid)) !== null) r.new = { ...c, stored: true };
  }
}

async function numstat(row: Row, attrs: AttrReader): Promise<[number, number] | null> {
  if (row.counts !== undefined) return row.counts;
  // The same blob and mode on both sides only happens against a worktree (it differs from the index):
  // git lists the path but prints no numstat for it. A conflict's row takes its `U` record's `0 0` then.
  if (same(row.old, row.new) && row.status !== 'U' && row.oldPath === null) return null;
  const a = row.old ? await row.old.load() : new Uint8Array();
  const b = row.new ? await row.new.load() : new Uint8Array();
  const binary = isBinaryHead(a) || isBinaryHead(b) || binaryByAttr(await attrs.get(row.path)) || (row.oldPath !== null && binaryByAttr(await attrs.get(row.oldPath)));
  // A binary is `- -` even when its blob didn't change (a mode change, an exact rename).
  if (binary) return null;
  if (row.old && row.new && row.old.oid === row.new.oid) return [0, 0];
  return countEdits(diffLines(splitLines(latin1(a)), splitLines(latin1(b))));
}

function source(c: Content | null, worktree: string): BlobSource {
  if (!c) return { kind: 'absent' };
  if (c.mode === MODE_GITLINK) return { kind: 'submodule', oid: c.oid };
  return c.stored ? { kind: 'object', oid: c.oid } : { kind: 'worktree', worktree };
}

/** The rows as `FileChange`s, with their counts; `keep` sees each row's counts first. `attrRoot`: the
 *  worktree whose `.gitattributes` decide what's binary (git's cwd). */
async function finish(repo: ReadRepo, rows: Row[], worktree: string, attrRoot: string, keep?: (r: Row, counts: [number, number] | null) => boolean): Promise<FileChange[]> {
  const attrs = new AttrReader(repo, attrRoot);
  const out: FileChange[] = [];
  for (const r of rows) {
    const counts = await numstat(r, attrs);
    if (keep && !keep(r, counts)) continue;
    out.push({
      path: r.path,
      oldPath: r.oldPath,
      status: r.status,
      additions: counts ? counts[0] : null,
      deletions: counts ? counts[1] : null,
      old: source(r.old, worktree),
      new: source(r.new, worktree),
      submodule: r.old?.mode === MODE_GITLINK || r.new?.mode === MODE_GITLINK,
      ...(r.conflict ? { conflict: r.conflict } : {}),
      ...(r.submoduleState ? { submoduleState: r.submoduleState } : {}),
    });
  }
  return out;
}

/** `from` → `to` (a commit against a parent, or a compare); `from` null: the root commit's files. */
export async function treeChanges(repo: ReadRepo, from: string | null, to: string): Promise<FileChange[]> {
  const rows: Row[] = (await diffTrees(repo, from, to)).map((c) => ({ status: statusOf(c.old, c.new), path: c.path, oldPath: null, old: c.old && stored(repo, c.old), new: c.new && stored(repo, c.new) }));
  return finish(repo, await withRenames(rows), '', repo.dir);
}

interface Wip {
  /** The worktree's validated path. */
  path: string;
  head: Map<string, FileEntry>;
  stage0: Map<string, IndexEntry>;
  unmerged: Map<string, IndexEntry[]>;
  /** The index file's mtime (ms), for git's stat check; null without one. */
  indexMtimeMs: number | null;
}

/** A worktree's own HEAD tree and index (a linked worktree has both of its own). */
async function readWip(repo: ReadRepo, root: string): Promise<Wip> {
  const wt = await worktreeOf(repo, root);
  const head = wt.head ? await listFiles(repo, wt.head) : new Map<string, FileEntry>();
  const stage0 = new Map<string, IndexEntry>();
  const unmerged = new Map<string, IndexEntry[]>();
  const indexMtimeMs = await indexMtime(repo, wt.gitdir);
  for (const e of await readIndex(repo, wt.gitdir)) {
    if (e.stage === 0) stage0.set(e.path, e);
    else unmerged.set(e.path, [...(unmerged.get(e.path) ?? []), e]);
  }
  return { path: wt.path, head, stage0, unmerged, indexMtimeMs };
}

const CONFLICT_KINDS: Record<string, ConflictKind> = { '123': 'bothModified', '23': 'bothAdded', '1': 'bothDeleted', '2': 'addedByUs', '3': 'addedByThem', '13': 'deletedByUs', '12': 'deletedByThem' };

function conflictKind(stages: IndexEntry[]): ConflictKind {
  return CONFLICT_KINDS[[1, 2, 3].filter((s) => stages.some((e) => e.stage === s)).join('')] ?? 'bothModified';
}

/** Tracked changes (staged or not) and untracked files inside a submodule's checkout. */
export async function nestedDirty(repo: ReadRepo, root: string, path: string): Promise<{ modified: boolean; untracked: boolean }> {
  const gitdir = await nestedGitdir(repo, root, path);
  if (!gitdir) return { modified: false, untracked: false };
  const dir = `${root}/${path}`;
  const sub = subRepo(repo, dir, gitdir);
  const indexMtimeMs = await indexMtime(sub, gitdir);
  const entries = (await readIndex(sub, gitdir)).filter((e) => e.stage === 0);
  const head = await nestedHead(repo, root, path);
  const headFiles = head ? await listFiles(sub, head) : new Map<string, FileEntry>();
  let modified = entries.length !== headFiles.size || entries.some((e) => !same(headFiles.get(e.path), e));
  for (const e of entries) {
    if (modified) break;
    if (e.mode === MODE_GITLINK || (await unchangedSinceIndex(sub, dir, e, indexMtimeMs))) continue;
    modified = !same(await trackedFile(sub, dir, e.path), e);
  }
  const untracked = (await untrackedFiles(sub, dir, new Set(entries.map((e) => e.path)))).length > 0;
  return { modified, untracked };
}

/** HEAD vs the index (`git diff --cached -M`), and one `U` row per conflicted path. */
export async function wipStaged(repo: ReadRepo, root: string): Promise<FileChange[]> {
  const w = await readWip(repo, root);
  const rows: Row[] = [];
  for (const path of new Set([...w.head.keys(), ...w.stage0.keys()])) {
    if (w.unmerged.has(path)) continue;
    const h = w.head.get(path) ?? null;
    const i = w.stage0.get(path) ?? null;
    if (same(h, i)) continue;
    rows.push({ status: statusOf(h, i), path, oldPath: null, old: h && stored(repo, h), new: i && stored(repo, i) });
  }
  const all = await withRenames(rows.sort(byPath));
  for (const path of w.unmerged.keys()) {
    const h = w.head.get(path) ?? null;
    all.push({ status: 'U', path, oldPath: null, old: h && stored(repo, h), new: null, counts: [0, 0] });
  }
  all.sort(byPath);
  for (const r of all) {
    const link = r.new?.mode === MODE_GITLINK || r.old?.mode === MODE_GITLINK;
    if (link && r.status !== 'D' && (await nestedHead(repo, w.path, r.path)) === null) {
      r.submoduleState = { newCommits: false, modifiedContent: false, untrackedContent: false, uninitialized: true };
    }
  }
  return finish(repo, all, w.path, w.path);
}

/** An untracked file's line count (`count_lines`): a regular file up to 2 MiB without a NUL in its
 *  first 8000 bytes; null otherwise. */
export function countLines(f: WorktreeFile): number | null {
  if (f.mode !== MODE_FILE && f.mode !== MODE_EXEC) return null;
  if (f.size > LARGE_FILE_BYTES || isBinaryHead(f.bytes)) return null;
  let n = 0;
  for (const b of f.bytes) if (b === 10) n++;
  return n + (f.bytes.length > 0 && f.bytes[f.bytes.length - 1] !== 10 ? 1 : 0);
}

/** A submodule's row in `git diff` (the index vs its checkout), or null when git lists nothing: not
 *  initialised, untracked content alone, or only edits inside one whose new commit is staged. */
async function submoduleRow(repo: ReadRepo, w: Wip, e: IndexEntry): Promise<Row | null> {
  const head = await nestedHead(repo, w.path, e.path);
  if (head === null) return null;
  const dirty = await nestedDirty(repo, w.path, e.path);
  const newCommits = head !== e.oid;
  if (!newCommits && !dirty.modified) return null;
  if (!newCommits && !same(w.head.get(e.path), e)) return null;
  const state: SubmoduleState = { newCommits, modifiedContent: dirty.modified, untrackedContent: dirty.untracked, uninitialized: false };
  // A dirty checkout at the recorded commit: git's numstat is `0 0`.
  return { status: 'M', path: e.path, oldPath: null, old: stored(repo, e), new: newCommits ? checkedOut(head) : stored(repo, e), submoduleState: state, ...(newCommits ? {} : { counts: [0, 0] }) };
}

/** The index vs the worktree (`git diff`, no renames: untracked files aren't in it), one `U` row per
 *  conflicted path, then the untracked files. */
export async function wipUnstaged(repo: ReadRepo, root: string): Promise<FileChange[]> {
  const w = await readWip(repo, root);
  const rows: Row[] = [];
  for (const e of w.stage0.values()) {
    if (e.mode === MODE_GITLINK) {
      const st = await lstatOrNull(repo, `${w.path}/${e.path}`);
      if (!st) {
        rows.push({ status: 'D', path: e.path, oldPath: null, old: stored(repo, e), new: null });
        continue;
      }
      if (st.isDirectory()) {
        const row = await submoduleRow(repo, w, e);
        if (row) rows.push(row);
        continue;
      }
    }
    if (await unchangedSinceIndex(repo, w.path, e, w.indexMtimeMs)) continue;
    const f = await trackedFile(repo, w.path, e.path);
    if (same(f, e)) continue;
    rows.push({ status: statusOf(e, f), path: e.path, oldPath: null, old: stored(repo, e), new: f && inWorktree(f) });
  }
  for (const [path, stages] of w.unmerged) {
    // git compares the worktree with stage 2 ("ours"); without one, it prints `0 0`.
    const ours = stages.find((s) => s.stage === 2) ?? null;
    const f = await trackedFile(repo, w.path, path);
    rows.push({ status: 'U', path, oldPath: null, old: ours && stored(repo, ours), new: f && inWorktree(f), conflict: conflictKind(stages), ...(ours ? {} : { counts: [0, 0] }) });
  }
  await hashAddedSides(repo, rows);
  const tracked = new Set([...w.stage0.keys(), ...w.unmerged.keys()]);
  for (const path of await untrackedFiles(repo, w.path, tracked)) {
    const f = await worktreeFile(repo, w.path, path);
    if (!f) continue;
    const lines = countLines(f);
    rows.push({ status: 'A', path, oldPath: null, old: null, new: inWorktree(f), counts: lines === null ? null : [lines, 0] });
  }
  return finish(repo, rows.sort(byPath), w.path, w.path);
}

/** A commit vs a worktree's files (`git diff -M <from> --`): each index path's worktree side (the index
 *  blob when the file still matches it), conflicted paths' files, untracked files left out. */
export async function worktreeChanges(repo: ReadRepo, root: string, from: string): Promise<FileChange[]> {
  const w = await readWip(repo, root);
  const base = await listFiles(repo, from);
  const rows: Row[] = [];
  for (const path of new Set([...base.keys(), ...w.stage0.keys(), ...w.unmerged.keys()])) {
    const b = base.get(path) ?? null;
    const e = w.stage0.get(path) ?? null;
    let now: Content | null = null;
    let counts: [number, number] | undefined;
    const link = e?.mode === MODE_GITLINK ? await lstatOrNull(repo, `${w.path}/${path}`) : null;
    if (e && link?.isDirectory()) {
      const head = await nestedHead(repo, w.path, path);
      if (head !== null && head !== e.oid) now = checkedOut(head);
      else {
        now = stored(repo, e);
        if (same(b, e)) {
          if (head === null || !(await nestedDirty(repo, w.path, path)).modified) continue;
          counts = [0, 0];
        }
      }
    } else if (e && !(e.mode === MODE_GITLINK && !link)) {
      if (await unchangedSinceIndex(repo, w.path, e, w.indexMtimeMs)) now = stored(repo, e);
      else {
        const f = await trackedFile(repo, w.path, path);
        now = f && (same(f, e) ? stored(repo, e) : inWorktree(f));
      }
    } else if (!e && w.unmerged.has(path)) {
      const f = await trackedFile(repo, w.path, path);
      now = f && inWorktree(f);
    }
    if (!b && !now) continue;
    // Only a side that's still the index's blob can be skipped: git lists any path that differs from
    // the index, even when it matches `from`.
    if (now?.stored && same(b, now) && counts === undefined) continue;
    rows.push({ status: statusOf(b, now), path, oldPath: null, old: b && stored(repo, b), new: now, ...(counts ? { counts } : {}) });
  }
  rows.sort(byPath);
  await hashAddedSides(repo, rows);
  // The core drops a binary `M` that `git status` calls clean (its phantom stat-dirty filter), and only
  // when its `from` side is the index's blob too: a path clean in status can still differ from `from`.
  const clean = (r: Row) => {
    const e = w.stage0.get(r.path);
    return !w.unmerged.has(r.path) && r.new?.stored === true && same(w.head.get(r.path), e) && e?.oid === r.old?.oid;
  };
  return finish(repo, await withRenames(rows), w.path, w.path, (r, counts) => !(r.status === 'M' && counts === null && clean(r)));
}

const IMAGE_DIFF_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'];

/** An image path without its extension (folder and stem); null for any other file, and for `.png`. */
function imageStem(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const stem = path.slice(0, dot);
  const name = stem.slice(stem.lastIndexOf('/') + 1);
  return name !== '' && IMAGE_DIFF_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase()) ? stem : null;
}

/** A format change (`shot.png` deleted, `shot.webp` added) as one `R` row, when it's the only deleted
 *  and the only added image with that folder and stem in the list. */
export function pairImageConversions(files: FileChange[]): FileChange[] {
  const byStem = new Map<string, { d: number[]; a: number[] }>();
  files.forEach((f, i) => {
    if (f.submodule || (f.status !== 'D' && f.status !== 'A')) return;
    const stem = imageStem(f.path);
    if (stem === null) return;
    const slot = byStem.get(stem) ?? { d: [], a: [] };
    byStem.set(stem, slot);
    (f.status === 'D' ? slot.d : slot.a).push(i);
  });
  const out = files.map((f) => ({ ...f }));
  const gone = new Set<number>();
  for (const { d, a } of byStem.values()) {
    if (d.length !== 1 || a.length !== 1) continue;
    const del = out[d[0]];
    const add = out[a[0]];
    add.status = 'R';
    add.oldPath = del.path;
    add.old = del.old;
    add.deletions = del.deletions;
    gone.add(d[0]);
  }
  return gone.size === 0 ? files : out.filter((_, i) => !gone.has(i));
}

export function totals(files: FileChange[]): FileListPayload {
  const list = pairImageConversions(files);
  const sum = (k: 'additions' | 'deletions') => Math.min(list.reduce((n, f) => n + (f[k] ?? 0), 0), 0xffff_ffff);
  return { files: list, added: sum('additions'), deleted: sum('deletions') };
}
