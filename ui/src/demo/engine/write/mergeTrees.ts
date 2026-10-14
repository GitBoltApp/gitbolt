/**
 * merge-ort's result for `theirs` into `ours` from `base`, as observed from `git merge` and
 * `git merge-tree --write-tree` (never from git's source). Each base path either side changed is
 * settled from both changes, renames paired by 1b's `sideOf`; paths only theirs added are added (a
 * content merge from nothing where ours has a file there). Then, as git leaves them:
 * - a file renamed to two names: the base's stage at its old path (no file there), each name
 *   holding the content merged from all three (markers included) as its side's stage;
 * - a file arriving where ours has another one (an addition, a rename's target): the two merged as
 *   two additions;
 * - a regular file against a symlink or a submodule: the regular file moves aside, the other kind
 *   keeps the path (two kinds that aren't regular files both move); the base's stage goes with the
 *   side of its kind, and is left out when neither side has it;
 * - a file where the result has a folder: the folder keeps the path, the file moves aside,
 *   conflicted with its side's stage (and the base's where the base had a file there).
 * Moving aside is to `<path>~<label>` (ours' label, or theirs' with `/` as `_`; `_0`, `_1`… when
 * that name is taken), its file written there.
 * Not as git does: directory renames aren't detected (each file merges at its own path). A file
 * arriving onto ours' rename whose own content merge conflicted merges with ours' file as committed:
 * git merges it with the rename's merged content, nesting that merge's 8-character markers inside
 * the two additions' ones (its stage 2 holds them too). Empty files never pair as renames (`sideOf`
 * follows gix's `track_empty`); `git merge` doesn't pair them either.
 */
import { compareBytewise, isBinaryHead, latin1, utf8Bytes } from '../read/bytes';
import type { IndexEntry, IndexStat } from '../read/indexFile';
import { splitLines } from '../read/lineDiff';
import { sideOf } from '../read/merge3';
import type { ReadRepo } from '../read/seam';
import { listFiles, MODE_FILE, MODE_GITLINK, MODE_LINK, modeType, readBlobBytes, type FileEntry } from '../read/trees';
import { checkoutEntry, kind, removeWorktreePath, writeFileState } from './files';
import { keepStat, loadIndex, saveIndex, stage0Of } from './index';
import { conflictCount, mergeLines, renderMerge } from './mergeFile';
import { clearFolder } from './move';
import { writeBlobBytes, writeTreeOf } from './objects';
import { latin1Bytes } from './patchApply';
import type { WriteWt } from './seam';

export interface MergeSideLabels {
  ours: string;
  theirs: string;
}
export type WorktreeWrite = { mode: number; oid: string } | { mode: number; bytes: Uint8Array } | null;
export interface TreeMerge {
  entries: IndexEntry[];
  worktree: Map<string, WorktreeWrite>;
  conflicts: string[];
  touched: string[];
}

type Stage = { mode: number; oid: string; stage: 1 | 2 | 3 };
type File = Exclude<WorktreeWrite, null>;
/** What a path holds after the merge: a clean entry, or a conflict's stages and its worktree file. */
type Slot = { clean: FileEntry } | { stages: Stage[]; file: File | null };
/** One side of a conflict moved aside to `<path>~<label>`. */
type Aside = { ours: boolean; stages: Stage[]; file: File | null };
type Merged = { slot: Slot | null; asides: Aside[] };

const sameEntry = (a: FileEntry, b: FileEntry) => a.oid === b.oid && a.mode === b.mode;
const st = (e: FileEntry, stage: 1 | 2 | 3): Stage => ({ mode: e.mode, oid: e.oid, stage });
const fileOf = (e: FileEntry): File => ({ mode: e.mode, oid: e.oid });
const one = (slot: Slot): Merged => ({ slot, asides: [] });
const isRegular = (e: FileEntry) => modeType(e.mode) === modeType(MODE_FILE);

/** Two kinds of file at one place: the regular one moves aside (both when neither is). */
function splitKinds(base: FileEntry | null, o: FileEntry, t: FileEntry): Merged {
  const kindOf = (e: FileEntry | null) => (e ? modeType(e.mode) : null);
  const sides = [
    { ours: true, e: o, stage: 2 as const, moves: isRegular(o) || !isRegular(t) },
    { ours: false, e: t, stage: 3 as const, moves: isRegular(t) || !isRegular(o) },
  ];
  // The base's stage goes with the side of its kind; a base of a third kind has none.
  const baseSide = sides.find((s) => kindOf(s.e) === kindOf(base));
  const out: Merged = { slot: null, asides: [] };
  for (const s of sides) {
    const stages = [...(base && s === baseSide ? [st(base, 1)] : []), st(s.e, s.stage)];
    if (s.moves) out.asides.push({ ours: s.ours, stages, file: fileOf(s.e) });
    else out.slot = { stages, file: fileOf(s.e) };
  }
  return out;
}

/** Two entries at one place, from `base` (null: two additions); `markers`: the conflict markers' length. */
async function mergeEntry(repo: ReadRepo, base: FileEntry | null, o: FileEntry, t: FileEntry, labels: MergeSideLabels, markers: number): Promise<Merged> {
  if (sameEntry(o, t)) return one({ clean: o });
  if (base && sameEntry(base, o)) return one({ clean: t });
  if (base && sameEntry(base, t)) return one({ clean: o });
  const kind = modeType(o.mode);
  if (kind !== modeType(t.mode)) return splitKinds(base, o, t);
  const stages: Stage[] = [...(base ? [st(base, 1)] : []), st(o, 2), st(t, 3)];
  const kept = one({ stages, file: fileOf(o) });
  if (kind === MODE_LINK || kind === MODE_GITLINK) return kept;
  // Two regular files: the mode one side changed (two additions that disagree on it conflict).
  if (!base && o.oid === t.oid) return kept;
  const mode = base && base.mode === o.mode ? t.mode : o.mode;
  if (o.oid === t.oid) return one({ clean: { oid: o.oid, mode } });
  if (base?.oid === o.oid) return one({ clean: { oid: t.oid, mode } });
  if (base?.oid === t.oid) return one({ clean: { oid: o.oid, mode } });
  const b = base && modeType(base.mode) === kind ? await readBlobBytes(repo, base.oid) : new Uint8Array();
  const [ob, tb] = [await readBlobBytes(repo, o.oid), await readBlobBytes(repo, t.oid)];
  if (isBinaryHead(b) || isBinaryHead(ob) || isBinaryHead(tb)) return kept;
  const chunks = mergeLines(splitLines(latin1(b)), splitLines(latin1(ob)), splitLines(latin1(tb)), 'merge');
  // The labels go into the file as UTF-8, as git writes them (the merge itself is of Latin-1 strings).
  const label = (l: string) => latin1(utf8Bytes(l));
  const bytes = latin1Bytes(renderMerge(chunks, 'merge', { ours: label(labels.ours), base: '', theirs: label(labels.theirs) }, markers));
  if (conflictCount(chunks) === 0) return one({ clean: { oid: await writeBlobBytes(repo, bytes), mode } });
  return one({ stages, file: { mode, bytes } });
}

/** `markerSize` gives a path's `conflict-marker-size` (7 when it isn't set). */
export async function mergeTrees(repo: ReadRepo, base: string, ours: string, theirs: string, labels: MergeSideLabels, markerSize: (path: string) => Promise<number> = async () => 7): Promise<TreeMerge> {
  const B = await listFiles(repo, base);
  const O = await listFiles(repo, ours);
  const mine = await sideOf(repo, base, ours);
  const yours = await sideOf(repo, base, theirs);
  const slots = new Map<string, Slot>([...O].map(([p, e]) => [p, { clean: e }]));
  const asides: { path: string; aside: Aside }[] = [];
  const labelsFor = (oursPath: string, theirsPath: string): MergeSideLabels =>
    oursPath === theirsPath ? labels : { ours: `${labels.ours}:${oursPath}`, theirs: `${labels.theirs}:${theirsPath}` };

  const place = (path: string, r: Merged) => {
    if (r.slot) slots.set(path, r.slot);
    else slots.delete(path);
    for (const aside of r.asides) asides.push({ path, aside });
  };
  /** A merge's content as one entry, markers included; null when it kept the sides apart. */
  const contentOf = async (r: Merged): Promise<FileEntry | null> => {
    if (!r.slot || r.asides.length > 0) return null;
    if ('clean' in r.slot) return r.slot.clean;
    const f = r.slot.file;
    return f && 'bytes' in f ? { mode: f.mode, oid: await writeBlobBytes(repo, f.bytes) } : null;
  };
  /** Theirs' `e` arriving at `path`: `alone` where nothing is there, else merged with ours' file
   *  there as two additions (still conflicted when the path or the arrival already was). */
  const arrive = async (path: string, e: FileEntry, alone: Slot, conflicted: boolean) => {
    const s = slots.get(path);
    const occ = !s ? null : 'clean' in s ? s.clean : (s.stages.find((x) => x.stage === 2) ?? null);
    if (!s || !occ) return void slots.set(path, alone);
    const r = await mergeEntry(repo, null, { mode: occ.mode, oid: occ.oid }, e, labels, await markerSize(path));
    if ((conflicted || !('clean' in s)) && r.slot && 'clean' in r.slot) r.slot = { stages: [st(occ, 2), st(e, 3)], file: fileOf(r.slot.clean) };
    place(path, r);
  };

  for (const [p, { base: b, now: tNow }] of yours.moved) {
    // undefined: ours left p as the base had it.
    const oNow = mine.moved.get(p)?.now;
    if (oNow === undefined) {
      if (tNow === null) slots.delete(p);
      else if (tNow.path === p) slots.set(p, { clean: tNow.entry });
      else {
        slots.delete(p);
        await arrive(tNow.path, tNow.entry, { clean: tNow.entry }, false);
      }
      continue;
    }
    if (oNow === null && tNow === null) continue;
    if (oNow === null) {
      const t = tNow!.entry;
      await arrive(tNow!.path, t, { stages: [st(b, 1), st(t, 3)], file: fileOf(t) }, true);
      continue;
    }
    if (tNow === null) {
      slots.set(oNow.path, { stages: [st(b, 1), st(oNow.entry, 2)], file: fileOf(oNow.entry) });
      continue;
    }
    const twoNames = oNow.path !== tNow.path && oNow.path !== p && tNow.path !== p;
    // Where one side renamed p, the merged path; git reads the attribute there. Two names: the base path.
    const at = oNow.path !== p ? oNow.path : tNow.path;
    // git's merge for two names marks its conflicts with 8-character markers.
    const r = await mergeEntry(repo, b, oNow.entry, tNow.entry, labelsFor(oNow.path, tNow.path), (await markerSize(twoNames ? p : at)) + (twoNames ? 1 : 0));
    if (twoNames) {
      // Renamed to two names: each gets the merged content where the sides merge.
      const merged = await contentOf(r);
      const [o, t] = merged ? [merged, merged] : [oNow.entry, tNow.entry];
      slots.set(p, { stages: [st(b, 1)], file: null });
      // A file of theirs that already arrived at ours' name merges with it as two additions.
      const prior = slots.get(oNow.path);
      const came = prior && !('clean' in prior) ? prior.stages.find((x) => x.stage === 3) : undefined;
      slots.set(oNow.path, { stages: [st(o, 2)], file: fileOf(o) });
      if (came) await arrive(oNow.path, { mode: came.mode, oid: came.oid }, { clean: o }, true);
      await arrive(tNow.path, t, { stages: [st(t, 3)], file: fileOf(t) }, true);
      continue;
    }
    // One place: both at p, one side renamed, or both renamed alike.
    if (oNow.path !== at) {
      // Theirs renamed p: ours' p goes with it, onto any file ours has at the new name.
      slots.delete(oNow.path);
      if (slots.has(at)) {
        const conflicted = !r.slot || !('clean' in r.slot);
        await arrive(at, (await contentOf(r)) ?? tNow.entry, { clean: tNow.entry }, conflicted);
        continue;
      }
    }
    place(at, r);
  }
  for (const [q, add] of yours.put) if (add.from === null) await arrive(q, add.entry, { clean: add.entry }, false);

  // A file where the result has a folder moves aside.
  const folders = new Set<string>();
  for (const [p, s] of slots) {
    if (!('clean' in s) && s.file === null && s.stages.every((x) => x.stage === 1)) continue;
    for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) folders.add(p.slice(0, i));
  }
  for (const p of folders) {
    const s = slots.get(p);
    if (!s) continue;
    slots.delete(p);
    const own = O.has(p);
    const b = B.get(p);
    const stages = 'clean' in s ? [...(b ? [st(b, 1)] : []), st(s.clean, own ? 2 : 3)] : s.stages;
    asides.push({ path: p, aside: { ours: own, stages, file: 'clean' in s ? fileOf(s.clean) : s.file } });
  }
  for (const { path, aside } of asides) {
    const stem = `${path}~${(aside.ours ? labels.ours : labels.theirs).replaceAll('/', '_')}`;
    let name = stem;
    for (let n = 0; slots.has(name); n++) name = `${stem}_${n}`;
    slots.set(name, { stages: aside.stages, file: aside.file });
  }

  const entries: IndexEntry[] = [];
  const files = new Map<string, File>();
  for (const [path, s] of slots) {
    if ('clean' in s) {
      entries.push({ path, mode: s.clean.mode, oid: s.clean.oid, stage: 0 });
      files.set(path, fileOf(s.clean));
      continue;
    }
    for (const x of s.stages) entries.push({ path, mode: x.mode, oid: x.oid, stage: x.stage });
    if (s.file) files.set(path, s.file);
  }
  entries.sort((a, b) => compareBytewise(a.path, b.path) || a.stage - b.stage);
  // Removals first (ours' files the result doesn't have), then writes.
  const worktree = new Map<string, WorktreeWrite>();
  for (const p of O.keys()) if (!files.has(p)) worktree.set(p, null);
  for (const [p, f] of [...files].sort(([x], [y]) => compareBytewise(x, y))) {
    const o = O.get(p);
    if (!o || 'bytes' in f || !sameEntry(o, f)) worktree.set(p, f);
  }
  const conflicts = [...slots].filter(([, s]) => !('clean' in s)).map(([p]) => p).sort(compareBytewise);
  const touched = [...new Set([...worktree.keys(), ...conflicts])].sort(compareBytewise);
  return { entries, worktree, conflicts, touched };
}

/** The merge's result into the worktree and the index: removals first, then writes (a folder left
 *  where a file goes holds only ignored files by then: they go with it, as git's do); a stage-0 entry
 *  the merge didn't write keeps its stat data when it names the same blob. */
export async function applyMerge(wt: WriteWt, m: TreeMerge): Promise<void> {
  const current = stage0Of(await loadIndex(wt));
  for (const [p, w] of m.worktree) if (w === null) removeWorktreePath(wt, p);
  const stats = new Map<string, IndexStat | null>();
  for (const [p, w] of m.worktree) {
    if (w === null) continue;
    if (w.mode !== MODE_GITLINK && kind(wt, `${wt.root}/${p}`) === 'dir') clearFolder(wt, p);
    stats.set(p, 'oid' in w ? await checkoutEntry(wt, p, w) : writeFileState(wt, p, { mode: w.mode, bytes: w.bytes }));
  }
  const next = m.entries.map((e) => {
    if (e.stage !== 0) return e;
    const st = stats.get(e.path);
    if (st) return { ...e, stat: st };
    return m.worktree.has(e.path) ? e : keepStat(current, e);
  });
  await saveIndex(wt, next);
}

/** The result as a tree, conflict markers included (git's AUTO_MERGE): the clean entries and each
 *  conflicted path's file (ours' own where the merge left it as it was). */
export async function resultTree(repo: ReadRepo, m: TreeMerge): Promise<string> {
  const files = new Map<string, { mode: number; oid: string }>();
  for (const e of m.entries) if (e.stage === 0) files.set(e.path, e);
  for (const p of m.conflicts) {
    const w = m.worktree.get(p);
    if (w === null) continue;
    if (w === undefined) {
      const o = m.entries.find((e) => e.path === p && e.stage === 2);
      if (o) files.set(p, o);
    } else files.set(p, 'oid' in w ? w : { mode: w.mode, oid: await writeBlobBytes(repo, w.bytes) });
  }
  return writeTreeOf(repo, [...files].map(([path, e]) => ({ path, mode: e.mode, oid: e.oid })));
}
