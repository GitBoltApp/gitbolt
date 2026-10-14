// Discards (write/discard.rs, spec #2 §7.2–§7.4): every one snapshots first and records an `after`
// snapshot of the same paths, so Undo restores `before` and Redo `after`. What git does for each
// scope (`clean -f`, `restore --worktree`, `restore --source=HEAD --staged --worktree`, a reverse
// apply onto the file), done on the demo's files. An untracked folder holding a repository of its
// own never shows in the demo's status (1b's `untrackedFiles` skips it), so the core's "separate Git
// repository" refusals for untracked rows have nothing to refuse here.
import type { DiscardScope } from '../../api/gen/DiscardScope';
import type { StageSelection } from '../../api/gen/StageSelection';
import type { WipBase } from '../../api/gen/WipBase';
import type { HandlerTable } from '../transport';
import { compareBytewise, latin1 } from '../engine/read/bytes';
import type { DiffHunk } from '../engine/read/lineDiff';
import { splitLines } from '../engine/read/lineDiff';
import { fail, isGbError } from '../engine/read/seam';
import { listFiles, MODE_GITLINK, type FileEntry } from '../engine/read/trees';
import { checkRelative } from '../engine/read/worktree';
import { checkoutEntry, kind, readFileState, repoAt, writeFileState } from '../engine/write/files';
import { readHead } from '../engine/write/refs';
import { loadIndex, saveIndex, stage0Of, withEntry, type IndexEntry } from '../engine/write/index';
import { applySelection, checkedDiff, latin1Bytes, selectionLabel, staleShown } from '../engine/write/patchApply';
import { runWrite, type WriteCx, type WriteIntent } from '../engine/write/run';
import { writeTarget, type WriteWt } from '../engine/write/seam';
import { createSnapshot, othersUnder } from '../engine/write/snapshot';
import { statusEntries, type StatusEntry } from '../engine/write/status';
import { filesLabel, NO_EXPECT, staleChange } from './stage';

interface Targets {
  /** Tracked paths written back: from the index, or from HEAD for All. */
  restore: string[];
  /** Untracked files deleted. */
  delete: string[];
  /** Files outside the index that writing `restore` back removes (collisions). */
  inWay: string[];
}

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort(compareBytewise);

/** The snapshot's `(paths, untracked)`: every file the discard removes or overwrites. */
function snapshotOf(t: Targets): [string[], string[]] {
  const untracked = uniqSorted([...t.delete, ...t.inWay]);
  return [uniqSorted([...t.restore, ...untracked]), untracked];
}

/** A row with an unstaged change: an untracked file, or a worktree change of a tracked one. */
const unstaged = (e: StatusEntry) => e.kind === 'untracked' || e.worktree !== '.';

const kindAt = (wt: WriteWt, p: string) => kind(wt, `${wt.root}/${p}`);

/** M3: a tracked folder replaced by a symbolic link; git refuses the path, so it's refused here first. */
function refuseSymlinkedFolders(wt: WriteWt, restore: string[]): void {
  for (const r of restore) {
    const parts = r.split('/');
    for (let i = 1; i < parts.length; i++) {
      const lead = parts.slice(0, i).join('/');
      const k = kindAt(wt, lead);
      if (k === 'link') fail('InvalidInput', `${lead} is a symbolic link where a folder of ${r} was: move it first`);
      if (k !== 'dir') break;
    }
  }
}

/** Files outside the index that writing `restore` back removes: everything in a folder standing where
 *  a file comes back (ignored files too), and a file standing where one of a path's folders must be
 *  (`in_the_way`). */
function inTheWay(wt: WriteWt, restore: string[], known: Set<string>, indexed: Set<string>): string[] {
  const out = new Set<string>();
  for (const r of restore) {
    if (kindAt(wt, r) === 'dir') for (const f of othersUnder(wt, r, indexed)) if (!known.has(f)) out.add(f);
    const parts = r.split('/');
    for (let i = 1; i < parts.length; i++) {
      const lead = parts.slice(0, i).join('/');
      const k = kindAt(wt, lead);
      if (k === 'dir') continue;
      if (k !== null && !known.has(lead)) out.add(lead);
      break;
    }
  }
  return [...out].sort(compareBytewise);
}

async function planTargets(wt: WriteWt, scope: DiscardScope): Promise<Targets> {
  const t = await targetsOf(wt, scope);
  // Last, as the core's `plan_targets` checks it: after the folder, repository and in-the-way refusals.
  // A snapshot carries an intent-to-add entry as an untracked file: Undo couldn't bring the mark back.
  const s0 = stage0Of(await loadIndex(wt));
  const ita = t.restore.find((p) => s0.get(p)?.intentToAdd);
  if (ita !== undefined) fail('InvalidInput', `${ita} is intent-to-add (git add -N): stage it or unstage it first`);
  return t;
}

async function targetsOf(wt: WriteWt, scope: DiscardScope): Promise<Targets> {
  const entries = await statusEntries(wt.repo, wt.root);
  const index = await loadIndex(wt);
  const links = new Set(index.filter((e) => e.mode === MODE_GITLINK).map((e) => e.path));
  const t: Targets = { restore: [], delete: [], inWay: [] };
  // The paths whose target (what git writes back) is a gitlink: only the index entry changes.
  let linkTargets = new Set<string>();
  if (scope.kind === 'paths') {
    const restore = new Set<string>();
    const del = new Set<string>();
    for (const raw of scope.paths) {
      const p = raw.replace(/\/+$/, '');
      checkRelative(p);
      const exact = entries.filter((e) => e.path === p);
      // A folder row: the changed files under it (a conflicted one has its own row).
      const rows = exact.length > 0 ? exact : entries.filter((e) => e.path.startsWith(`${p}/`) && e.kind !== 'unmerged');
      const picked = rows.filter((e) => unstaged(e) && !links.has(e.path));
      if (picked.length === 0) {
        const sub = rows.find((e) => links.has(e.path));
        if (sub) fail('InvalidInput', `${sub.path} is a submodule: discard its changes inside it`);
        // Gone, or only staged now: the list was drawn before.
        staleChange([p]);
      }
      for (const e of picked) (e.kind === 'untracked' ? del : restore).add(e.path);
    }
    t.restore = [...restore].sort(compareBytewise);
    t.delete = [...del].sort(compareBytewise);
  } else if (scope.kind === 'patch') {
    checkRelative(scope.path);
    if (entries.some((e) => e.path === scope.path && e.kind === 'untracked')) t.delete = [scope.path];
    else t.restore = [scope.path];
  } else if (scope.kind === 'unstaged') {
    for (const e of entries) if (unstaged(e) && !links.has(e.path) && e.kind !== 'unmerged') (e.kind === 'untracked' ? t.delete : t.restore).push(e.path);
  } else {
    // The snapshot can't carry a conflicted path, and Discard all can't leave one.
    const conflicted = entries.find((e) => e.kind === 'unmerged');
    if (conflicted) fail('InProgress', `${conflicted.path} has merge conflicts: resolve conflicts first`);
    // UX R1 C.2: never more than the user confirmed.
    if (scope.confirmed) {
      const ok = new Set(scope.confirmed.map((p) => p.replace(/\/+$/, '')));
      const outside = entries.flatMap((e) => [e.path, ...(e.origPath ? [e.origPath] : [])]).find((p) => !ok.has(p));
      if (outside !== undefined) fail('Stale', `${outside} changed since you confirmed: look again, then discard`);
    }
    const restore = new Set<string>();
    for (const e of entries.filter((x) => x.kind !== 'untracked')) {
      restore.add(e.path);
      if (e.origPath) restore.add(e.origPath); // a rename's source comes back from HEAD
    }
    // An untracked file at a rename's source is overwritten with HEAD's: it's a tracked path.
    t.delete = entries.filter((e) => e.kind === 'untracked' && !restore.has(e.path)).map((e) => e.path);
    t.restore = [...restore].sort(compareBytewise);
  }
  // The file is rewritten in place: nothing else is in the way.
  if (scope.kind === 'patch') return t;
  const head = readHead(wt).oid;
  // HEAD's gitlink back at a path (M2): git re-adds the index entry and never touches the folder.
  if (scope.kind === 'all' && head) {
    const files = await listFiles(wt.repo, head);
    linkTargets = new Set(t.restore.filter((p) => files.get(p)?.mode === MODE_GITLINK));
  }
  refuseSymlinkedFolders(wt, t.restore);
  // `rm --cached` writes no file, and only files are deleted after it: nothing is in the way.
  if (scope.kind === 'all' && !head) return t;
  const writes = t.restore.filter((p) => !linkTargets.has(p));
  // C1: writing a file where a repository stands would delete it, `.git` and all.
  const indexLinks = [...links];
  for (const p of writes) {
    if (repoAt(wt, p) || indexLinks.some((g) => g === p || g.startsWith(`${p}/`))) fail('InvalidInput', `${p} is a repository in the way: move it first`);
  }
  t.inWay = inTheWay(wt, writes, new Set([...t.restore, ...t.delete]), new Set(index.map((e) => e.path)));
  return t;
}

/** `discard a.php`, `discard 3 files`, `discard a hunk in a.php`, `discard 3 lines in a.php`,
 *  `discard unstaged changes`, `discard all changes` (§5.5). `what`: a patch's selection label. */
function labelOf(scope: DiscardScope, t: Targets, what: string | null): string {
  switch (scope.kind) {
    case 'paths':
      return `discard ${filesLabel(snapshotOf(t)[0])}`;
    case 'patch':
      return `discard ${what} in ${scope.path}`;
    case 'unstaged':
      return 'discard unstaged changes';
    case 'all':
      return 'discard all changes';
  }
}

const nothingSelected = (): never => fail('InvalidInput', 'No changed lines are selected');

/** `discard::checked_diff`: the read layer's refusals name staging; here it's a discard. */
async function discardDiff(wt: WriteWt, path: string, base: WipBase): Promise<DiffHunk[]> {
  try {
    return (await checkedDiff(wt, path, false, base)).hunks;
  } catch (e) {
    if (isGbError(e) && e.kind === 'InvalidInput') throw { ...e, message: e.message.replace('stage the whole file', 'discard the whole file') };
    throw e;
  }
}

/** Deviation 6: an untracked file's picked new lines cut out of its bytes (it has no index version to
 *  reverse-apply against). */
function dropNewLines(text: string, hunks: DiffHunk[], sel: StageSelection): string {
  const hunk = hunks[0] ?? nothingSelected();
  const add = hunk.lines.filter((l) => l.kind === 'add').map((l) => l.new);
  const picked = new Set(sel.kind === 'hunks' ? (sel.hunks.includes(0) ? add : []) : add.filter((n) => sel.new.some((r) => n >= r.start && n <= r.end)));
  if (picked.size === 0) nothingSelected();
  return splitLines(text).filter((_, i) => !picked.has(i + 1)).join('');
}

/** §7.3 "Discard lines or hunk": the selection reverse-applied to the worktree file, its mode kept;
 *  the index is never touched. */
async function discardPatch(cx: WriteCx, path: string, sel: StageSelection, base: WipBase, untracked: boolean): Promise<void> {
  const hunks = await discardDiff(cx.wt, path, base);
  const k = kindAt(cx.wt, path);
  if (k === null) staleShown(path);
  const file = k === 'file' ? readFileState(cx.wt, path) : null;
  if (!file) fail('InvalidInput', `${path} is deleted: discard the whole file instead`);
  if (untracked) {
    const kept = dropNewLines(latin1(file.bytes), hunks, sel);
    cx.partial = true;
    writeFileState(cx.wt, path, { mode: file.mode, bytes: latin1Bytes(kept) });
    return;
  }
  const applied = applySelection(splitLines(latin1(file.bytes)), hunks, sel, 'reverse');
  if (!applied) {
    const entry = stage0Of(await loadIndex(cx.wt)).get(path);
    const modeOnly = hunks.length === 0 && !!entry && entry.mode !== file.mode;
    fail('InvalidInput', modeOnly ? "Only the file's mode changed: discard the whole file" : hunks.length === 0 ? `No changes to discard in ${path}` : 'No changed lines are selected');
  }
  cx.partial = true;
  // What the core runs, against a temp index (GIT_INDEX_FILE, not recorded): the file's HEAD..worktree
  // state is added there, the selection reverse-applied, and the result checked out over the file.
  cx.command('add', '--', path);
  cx.command('apply', '--cached', '-R', '--recount', '--whitespace=nowarn', '-');
  cx.command('checkout-index', '-f', '--', path);
  writeFileState(cx.wt, path, { mode: file.mode, bytes: latin1Bytes(applied.lines.join('')) });
}

function discard(scope: DiscardScope, label: string): WriteIntent<null> {
  let targets: Targets | null = null;
  // M6: counted again under the lock, by `plan`, so the journal's label says what was done.
  let current = label;
  return {
    kind: 'discard',
    label: () => current,
    class: 'immediate',
    undo: () => 'restore',
    // §13.2: per-file discards run in the conflict state; Unstaged and All don't.
    allowedInProgress: scope.kind === 'paths' || scope.kind === 'patch',
    // Only Discard all rewrites the index; the others leave the staging log valid.
    staging: scope.kind === 'all' ? 'clear' : 'keep',
    plan: async (pre) => {
      // A patch whose base moved is Stale before anything is snapshotted or journaled.
      const what = scope.kind === 'patch' ? selectionLabel(await discardDiff(pre.wt, scope.path, scope.base), scope.selection, 'reverse') : null;
      targets = await planTargets(pre.wt, scope);
      current = labelOf(scope, targets, what);
      const [paths, untracked] = snapshotOf(targets);
      if (paths.length === 0) fail('InvalidInput', 'Nothing to discard');
      return { snapshot: { paths, untracked } };
    },
    run: async (cx) => {
      const snap = cx.snapshot!;
      const t = targets!;
      // Only what the snapshot holds is deleted or written over, never a path that appeared since.
      const held = new Set(snap.paths);
      const del = t.delete.filter((p) => snap.untracked.includes(p));
      // git removes what's in the way itself, as it writes the tracked paths back.
      const inWay = t.inWay.filter((p) => snap.untracked.includes(p));
      const restore = t.restore.filter((p) => held.has(p) && !snap.untracked.includes(p));
      if (scope.kind === 'patch') await discardPatch(cx, scope.path, scope.selection, scope.base, del.length > 0);
      else {
        let entries = await loadIndex(cx.wt);
        const s0 = stage0Of(entries);
        // Stale is checked before the clean here, the core's after it (with `partial` set): the demo
        // has nothing else running between plan and run, so a path leaving the index can't differ.
        // `git restore --worktree` of a path the index doesn't have: "did not match any file".
        if (scope.kind !== 'all' && restore.some((p) => !s0.has(p))) staleChange(restore);
        // From here the working tree may change, even if a step fails.
        cx.partial = true;
        for (const p of del) writeFileState(cx.wt, p, null);
        if (del.length > 0) cx.command('clean', '-f', '-q', '--', ...del);
        for (const p of inWay) writeFileState(cx.wt, p, null);
        if (scope.kind === 'all') {
          const head = cx.before.head.oid;
          if (!head) {
            // Unborn: out of the index, then their files deleted; a folder standing at one is left alone.
            for (const p of restore) {
              entries = withEntry(entries, p, null);
              if (readFileState(cx.wt, p)) writeFileState(cx.wt, p, null);
            }
            if (restore.length > 0) cx.command('rm', '--cached', '-f', '-q', '-r', '--pathspec-from-file=-', '--pathspec-file-nul');
          } else {
            const headFiles: Map<string, FileEntry> = await listFiles(cx.wt.repo, head);
            for (const p of restore) {
              const h = headFiles.get(p);
              const stat = h ? await checkoutEntry(cx.wt, p, h) : (writeFileState(cx.wt, p, null), null);
              entries = withEntry(entries, p, h ? { path: p, mode: h.mode, oid: h.oid, stage: 0, ...(stat ? { stat } : {}) } : null);
            }
            if (restore.length > 0) cx.command('restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul');
          }
          cx.touch('index');
        } else {
          for (const p of restore) {
            const e = s0.get(p)!;
            const stat = await checkoutEntry(cx.wt, p, e);
            entries = withEntry(entries, p, { ...e, ...(stat ? { stat } : {}) } as IndexEntry);
          }
          if (restore.length > 0) cx.command('restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul');
        }
        await saveIndex(cx.wt, entries);
      }
      // The same files as `before`, the untracked part too: a file still there (a cut untracked
      // file) is held again, a deleted one is absent.
      cx.after = await createSnapshot(cx.wt, snap.paths, snap.untracked);
      cx.touch('worktree');
      return null;
    },
  };
}

export const discardHandlers: Pick<HandlerTable, 'discard'> = {
  // Refused (Stale, a submodule, …) before the write runs; `plan` checks and counts again under the
  // lock (the journal's label is that one).
  discard: async ({ repo, worktree, scope }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    const what = scope.kind === 'patch' ? selectionLabel(await discardDiff(wt, scope.path, scope.base), scope.selection, 'reverse') : null;
    return runWrite(ctx, repo, worktree, NO_EXPECT, discard(scope, labelOf(scope, await planTargets(wt, scope), what)));
  },
};
