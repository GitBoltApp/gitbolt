// Snapshots (spec #2 §5.2; journal/snapshot.rs), in memory: each path a destructive write touches,
// its stage-0 entry and its file, so Undo restores `before` and Redo `after` byte for byte. The
// core keeps them as dangling stash-shaped commits; the demo's journal lives in memory, so do they.
import { gbError } from '../errors';
import { blobId, compareBytewise } from '../read/bytes';
import { listFiles, MODE_GITLINK, type FileEntry } from '../read/trees';
import { readFileState, sameFile, writeFileState, type FileState } from './files';
import { loadIndex, saveIndex, stage0Of, statOf, unmergedOf, type IndexEntry } from './index';
import { readHead } from './refs';
import type { WriteWt } from './seam';

export interface SnapPath {
  /** Its stage-0 entry (null: not in the index). Untracked paths: always null. */
  index: { mode: number; oid: string } | null;
  /** Its file or link; a gitlink as `{ mode: 160000 }` with no bytes; null: none, or a folder. */
  file: FileState | null;
  /** The file holds the entry's blob: a restore gives the entry the file's stat data back. */
  clean: boolean;
}

export interface Snapshot {
  /** P, files only: the untracked ones first, then the others in the order given. */
  paths: string[];
  /** The paths held as untracked files (the write deletes them). */
  untracked: string[];
  held: Map<string, SnapPath>;
}

const isDir = (wt: WriteWt, p: string) => {
  try {
    return wt.fs.lstatSync(`${wt.root}/${p}`).isDirectory();
  } catch {
    return false;
  }
};

/** Every file or link under `dir` that the index doesn't have (ignored ones too): `ls-files --others`. */
export function othersUnder(wt: WriteWt, dir: string, indexed: Set<string>): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of wt.fs.readdirSync(`${wt.root}/${rel}`)) {
      const p = `${rel}/${name}`;
      if (name === '.git') continue;
      if (isDir(wt, p)) walk(p);
      else if (!indexed.has(p)) out.push(p);
    }
  };
  walk(dir);
  return out.sort(compareBytewise);
}

/** The untracked files among `paths` themselves (a folder standing at one doesn't count): what a
 *  snapshot holds as untracked. The core's `untracked_files` (journal/undo.rs:818). */
export async function untrackedAmong(wt: WriteWt, paths: string[]): Promise<string[]> {
  const tracked = new Set((await loadIndex(wt)).map((e) => e.path));
  return paths.filter((p) => {
    if (tracked.has(p)) return false;
    try {
      return !wt.fs.lstatSync(`${wt.root}/${p}`).isDirectory();
    } catch {
      return false;
    }
  });
}

/** `files_only`. */
async function filesOnly(wt: WriteWt, paths: string[], untracked: string[], entries: IndexEntry[]): Promise<[string[], string[]]> {
  const indexed = new Set(entries.map((e) => e.path));
  const head = readHead(wt).oid;
  const headFiles: Map<string, FileEntry> = head ? await listFiles(wt.repo, head) : new Map();
  const pOut: string[] = [];
  const uOut: string[] = [];
  const seen = new Set<string>();
  for (const p of untracked) {
    for (const f of isDir(wt, p) ? othersUnder(wt, p, indexed) : [p]) {
      if (seen.has(f)) continue;
      seen.add(f);
      uOut.push(f);
      pOut.push(f);
    }
  }
  for (const p of paths.filter((x) => !untracked.includes(x))) {
    const under = [...new Set(entries.filter((e) => e.path.startsWith(`${p}/`)).map((e) => e.path))];
    const exact = indexed.has(p);
    const files = !exact && under.length > 0 ? [...under, ...(headFiles.has(p) ? [p] : [])] : !exact && under.length === 0 && isDir(wt, p) && !headFiles.has(p) ? [] : [p];
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      pOut.push(f);
    }
  }
  return [pOut, uOut];
}

/** An intent-to-add entry counts as absent from the index (the core's check_index). */
const realEntry = (e: IndexEntry | undefined) => (e && !e.intentToAdd ? e : undefined);

/** The folder `p` holds a file, not counting those in `leaving`. */
const hasFiles = (wt: WriteWt, p: string, leaving: ReadonlySet<string>): boolean =>
  wt.fs.readdirSync(`${wt.root}/${p}`).some((n) => (isDir(wt, `${p}/${n}`) ? hasFiles(wt, `${p}/${n}`, leaving) : !leaving.has(`${p}/${n}`)));

const GITLINK_FILE: FileState = { mode: MODE_GITLINK, bytes: new Uint8Array() };

function refuseConflicted(entries: IndexEntry[], snap: { paths: string[]; untracked: string[] }): void {
  const unmerged = unmergedOf(entries);
  const p = snap.paths.filter((x) => !snap.untracked.includes(x)).find((x) => unmerged.has(x));
  if (p !== undefined) throw gbError('InProgress', `${p} has merge conflicts: resolve conflicts first`);
}

export async function createSnapshot(wt: WriteWt, paths: string[], untracked: string[]): Promise<Snapshot> {
  const entries = await loadIndex(wt);
  const [p, u] = await filesOnly(wt, paths, untracked, entries);
  refuseConflicted(entries, { paths: p, untracked: u });
  const s0 = stage0Of(entries);
  const held = new Map<string, SnapPath>();
  for (const path of p) {
    const e = u.includes(path) ? undefined : realEntry(s0.get(path));
    const file = e?.mode === MODE_GITLINK ? GITLINK_FILE : readFileState(wt, path);
    const clean = !!e && !!file && file.mode === e.mode && (e.mode === MODE_GITLINK || (await blobId(file.bytes)) === e.oid);
    held.set(path, { index: e ? { mode: e.mode, oid: e.oid } : null, file, clean });
  }
  return { paths: p, untracked: u, held };
}

/** P's tracked entries from the snapshot into `entries` (a removal where it has none); a clean file's
 *  entry gets the file's stat data (`wt`), any other is hashed by the next status. */
function indexed(entries: IndexEntry[], snap: Snapshot, wt: WriteWt | null): IndexEntry[] {
  const tracked = new Set(snap.paths.filter((p) => !snap.untracked.includes(p)));
  const out = entries.filter((e) => !tracked.has(e.path));
  for (const p of tracked) {
    const h = snap.held.get(p)!;
    if (!h.index) continue;
    const stat = wt && h.clean ? statOf(wt, p) : null;
    out.push({ path: p, mode: h.index.mode, oid: h.index.oid, stage: 0, ...(stat ? { stat } : {}) });
  }
  return out;
}

/** `check_restore`: the restore's checks alone, so a caller can run them before it moves anything;
 *  `leaving` are files that caller's own move deletes first. */
export async function checkRestore(wt: WriteWt, snap: Snapshot, leaving: ReadonlySet<string> = new Set(), unmergedOk = false): Promise<void> {
  if (!unmergedOk) await checkRestoreIndex(wt, snap);
  for (const p of snap.paths) {
    const f = snap.held.get(p)!.file;
    if (f && f.mode !== MODE_GITLINK && isDir(wt, p) && hasFiles(wt, p, leaving)) throw gbError('DirtyWorktree', `${p} is a folder with files in it`);
  }
}

/** `snap` over `paths` alone (the core's undo.rs `only`): a stopped pick's Undo restores the paths
 *  of the commits it attempted. */
export function onlyPaths(snap: Snapshot, paths: readonly string[]): Snapshot {
  const keep = (p: string) => paths.includes(p);
  return { paths: snap.paths.filter(keep), untracked: snap.untracked.filter(keep), held: new Map([...snap.held].filter(([p]) => keep(p))) };
}

/** `restore_with`: the files first (W's, U's), then the tracked paths' index entries; a path in neither is unlinked.
 *  `unmergedOk` (a stopped pick's Undo, after its question): a conflicted path is restored too, its stages cleared. */
export async function restoreSnapshot(wt: WriteWt, snap: Snapshot, unmergedOk = false): Promise<void> {
  // Every path is checked before anything is written: no half-restored state.
  await checkRestore(wt, snap, undefined, unmergedOk);
  const entries = await loadIndex(wt);
  // Removals first, deepest first, so a folder emptied by them can take a file.
  const order = [...snap.paths].sort((a, b) => Number(snap.held.get(a)!.file !== null) - Number(snap.held.get(b)!.file !== null) || b.length - a.length);
  for (const p of order) {
    const f = snap.held.get(p)!.file;
    if (f === null) {
      if (!isDir(wt, p) || wt.fs.readdirSync(`${wt.root}/${p}`).length === 0) writeFileState(wt, p, null);
    } else if (f.mode === MODE_GITLINK || !sameFile(readFileState(wt, p), f)) writeFileState(wt, p, f);
  }
  await saveIndex(wt, indexed(entries, snap, wt));
}

/** `restoreSnapshotIndex`'s checks alone. */
export async function checkRestoreIndex(wt: WriteWt, snap: Snapshot): Promise<void> {
  refuseConflicted(await loadIndex(wt), snap);
}

/** The index part only (a mixed reset's undo): P's entries, the worktree untouched. */
export async function restoreSnapshotIndex(wt: WriteWt, snap: Snapshot): Promise<void> {
  await checkRestoreIndex(wt, snap);
  await saveIndex(wt, indexed(await loadIndex(wt), snap, null));
}

/** `changed_since`: the paths whose index entry or file isn't what the snapshot holds (a gitlink's
 *  file never counts: its worktree is another repository's). */
export async function changedSince(wt: WriteWt, snap: Snapshot): Promise<string[]> {
  const entries = await loadIndex(wt);
  const s0 = stage0Of(entries);
  const unmerged = unmergedOf(entries);
  return snap.paths.filter((p) => {
    const h = snap.held.get(p)!;
    const now = realEntry(s0.get(p)) ?? null;
    const want = h.index;
    const indexChanged = unmerged.has(p) || (now === null ? want !== null : want === null || now.oid !== want.oid || now.mode !== want.mode);
    const fileChanged = h.file?.mode !== MODE_GITLINK && !sameFile(readFileState(wt, p), h.file);
    return indexChanged || fileChanged;
  });
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.paths.join('\0') !== b.paths.join('\0') || a.untracked.join('\0') !== b.untracked.join('\0')) return false;
  return a.paths.every((p) => {
    const x = a.held.get(p)!;
    const y = b.held.get(p)!;
    const sameIndex = x.index === null || y.index === null ? x.index === y.index : x.index.oid === y.index.oid && x.index.mode === y.index.mode;
    return sameIndex && sameFile(x.file, y.file);
  });
}
