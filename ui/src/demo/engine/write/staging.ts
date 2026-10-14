// The staging undo log (spec #2 §7.6; journal/staging.rs): stage and unstage are steps of their own
// undo stack (the last 100, per worktree, for the page's life), each the index before and after as
// `write-tree` sees it plus the intent-to-add paths a tree can't carry; a conflict resolution is a
// step too (journal/resolve_step.rs): its path's stages and file before and after.
import type { StagingUndoState } from '../../../api/gen/StagingUndoState';
import { blobId } from '../read/bytes';
import { readFileState, sameFile, writeFileState, type FileState } from './files';
import { keepStat, loadIndex, saveIndex, stage0Of, statOf, withEntry, type IndexEntry } from './index';
import { EMPTY_BLOB } from './objects';
import type { WriteWt } from './seam';

export const STAGING_CAP = 100;
/** While files are conflicted with nothing to undo: stage and unstage aren't recorded then. */
export const CONFLICTED_OFF = "Stage and unstage can't be undone while files are conflicted.";
export const OUTSIDE = 'The index changed outside staging; staging history was cleared.';
export const RESOLVE_ENDED = 'The merge or rebase moved on since then; staging history was cleared.';

export interface IndexCapture {
  /** The stage-0 entries a tree holds (intent-to-add ones aren't), sorted. */
  entries: { path: string; mode: number; oid: string }[];
  ita: string[];
}

/** The index as a tree and its intent-to-add paths; null while files are conflicted (`write-tree` refuses). */
export async function captureIndex(wt: WriteWt): Promise<IndexCapture | null> {
  const entries = await loadIndex(wt);
  if (entries.some((e) => e.stage !== 0)) return null;
  return { entries: entries.filter((e) => !e.intentToAdd).map(({ path, mode, oid }) => ({ path, mode, oid })), ita: entries.filter((e) => e.intentToAdd).map((e) => e.path) };
}

const key = (c: IndexCapture) => c.entries.map((e) => `${e.path}\0${e.mode}\0${e.oid}`).join('\n');
export const sameTree = (a: IndexCapture, b: IndexCapture): boolean => key(a) === key(b);
export const sameCapture = (a: IndexCapture, b: IndexCapture): boolean => sameTree(a, b) && a.ita.join('\0') === b.ita.join('\0');

/** `read-tree --reset <tree>` (unchanged entries keep their stat data; the worktree is never touched),
 *  then `add -N` of the intent-to-add paths still on disk. */
export async function restoreCapture(wt: WriteWt, cap: IndexCapture): Promise<void> {
  const current = stage0Of(await loadIndex(wt));
  const out: IndexEntry[] = cap.entries.map((e) => keepStat(current, { ...e, stage: 0 }));
  for (const p of cap.ita) {
    const f = readFileState(wt, p);
    if (f) out.push({ path: p, mode: f.mode, oid: EMPTY_BLOB, stage: 0, intentToAdd: true });
  }
  await saveIndex(wt, out);
}

/** A path's index entries (every stage) and what the worktree holds there (`'other'`: a folder). */
export interface PathState {
  entries: { mode: number; oid: string; stage: number }[];
  disk: FileState | 'other' | null;
}

export async function capturePath(wt: WriteWt, path: string): Promise<PathState> {
  const entries = (await loadIndex(wt)).filter((e) => e.path === path).map(({ mode, oid, stage }) => ({ mode, oid, stage })).sort((a, b) => a.stage - b.stage);
  let disk: PathState['disk'] = readFileState(wt, path);
  if (disk === null && wt.fs.existsSync(`${wt.root}/${path}`, false)) disk = 'other';
  return { entries, disk };
}

const sameDisk = (a: PathState['disk'], b: PathState['disk']) => (a === 'other' || b === 'other' ? a === b : sameFile(a, b));

export function samePathState(a: PathState, b: PathState): boolean {
  return a.entries.length === b.entries.length && a.entries.every((e, i) => e.mode === b.entries[i].mode && e.oid === b.entries[i].oid && e.stage === b.entries[i].stage) && sameDisk(a.disk, b.disk);
}

/** A step can carry the path from `a` to `b` and back: each side's file is restorable, or they match. */
export const restorable = (a: PathState, b: PathState): boolean => sameDisk(a.disk, b.disk) || (a.disk !== 'other' && b.disk !== 'other');

/** The file first, then the index entries (every stage out, `to`'s in). */
export async function restorePath(wt: WriteWt, path: string, to: PathState): Promise<void> {
  if (to.disk !== 'other') writeFileState(wt, path, to.disk);
  let entries = withEntry(await loadIndex(wt), path, null);
  const fileBlob = to.disk && to.disk !== 'other' ? await blobId(to.disk.bytes) : null;
  for (const e of to.entries) {
    const stat = e.stage === 0 && e.oid === fileBlob ? statOf(wt, path) : null;
    entries = [...entries, { path, ...e, ...(stat ? { stat } : {}) }];
  }
  await saveIndex(wt, entries);
}

export type StagingChange = { kind: 'tree'; before: IndexCapture; after: IndexCapture } | { kind: 'resolve'; path: string; before: PathState; after: PathState; op: string | null };

export interface StagingStep {
  label: string;
  /** HEAD when it ran. */
  head: string | null;
  change: StagingChange;
}

export class StagingLog {
  undo: StagingStep[] = [];
  redo: StagingStep[] = [];

  record(step: StagingStep): void {
    this.redo = [];
    this.undo.push(step);
    if (this.undo.length > STAGING_CAP) this.undo.shift();
  }

  clear(): void {
    this.undo = [];
    this.redo = [];
  }

  /** Only the resolutions stay: a tree step can't be checked while files are conflicted. */
  keepResolves(): void {
    this.undo = this.undo.filter((s) => s.change.kind === 'resolve');
    this.redo = this.redo.filter((s) => s.change.kind === 'resolve');
  }

  /** The top step to the other stack: undo → redo (`toRedo`), or back. */
  shift(toRedo: boolean): void {
    const s = (toRedo ? this.undo : this.redo).pop();
    if (s) (toRedo ? this.redo : this.undo).push(s);
  }

  state(off: string | null): StagingUndoState {
    if (off !== null) return { undo: null, redo: null, off };
    return { undo: this.undo.at(-1)?.label ?? null, redo: this.redo.at(-1)?.label ?? null, off: null };
  }
}

/** `staging::state`: in a conflicted worktree only resolutions stay; with none, the buttons say why they're off. */
export function stagingStateOf(log: StagingLog, conflicted: boolean): StagingUndoState {
  if (!conflicted) return log.state(null);
  log.keepResolves();
  return log.undo.length === 0 && log.redo.length === 0 ? log.state(CONFLICTED_OFF) : log.state(null);
}
