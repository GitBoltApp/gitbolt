// Stage and unstage whole files (write/stage.rs, spec #2 §7.2): immediate writes, each a staging
// step (§7.6). What `git add -A -- <paths>`, `git restore --staged -- <paths>` (`rm --cached` while
// HEAD is unborn), `git add -A` and `restore --staged :/` do, every path literal. Hunks and lines
// (write/stage_patch.rs, §7.3): the selection applied to the index's text, as `git apply --cached
// [-R]` of the core's partial patch leaves it.
import type { StageSelection } from '../../api/gen/StageSelection';
import type { WipBase } from '../../api/gen/WipBase';
import type { HandlerTable } from '../transport';
import { latin1 } from '../engine/read/bytes';
import { splitLines } from '../engine/read/lineDiff';
import { fail } from '../engine/read/seam';
import { listFiles, readBlobBytes, type FileEntry } from '../engine/read/trees';
import { untrackedFiles, worktreeFile } from '../engine/read/worktree';
import { entryOfFile, keepStat, loadIndex, saveIndex, stage0Of, statOf, withEntry, type IndexEntry } from '../engine/write/index';
import { refuseBeyondLink } from '../engine/write/files';
import { writeBlobBytes } from '../engine/write/objects';
import { applySelection, checkedDiff, latin1Bytes, selectionLabel } from '../engine/write/patchApply';
import { NO_EXPECT, runWrite, type WriteIntent } from '../engine/write/run';
import { writeTarget, type WriteWt } from '../engine/write/seam';
import { statusEntries } from '../engine/write/status';

export { NO_EXPECT };

/** "a.php" or "3 files" (§5.5, §7.6). */
export const filesLabel = (paths: string[]): string => (paths.length === 1 ? paths[0] : `${paths.length} files`);

/** git's "pathspec did not match any files": the list was drawn before the file changed. */
export function staleChange(paths: string[]): never {
  return fail('Stale', `${paths[0] ?? 'A file'} changed since it was shown`);
}

const under = (p: string, q: string) => q === p || q.startsWith(`${p}/`);

/** `git add -A -- <paths>`: every file at or under each path, as the worktree has it. */
async function addPaths(wt: WriteWt, entries: IndexEntry[], paths: string[], shown: string[]): Promise<IndexEntry[]> {
  const indexed = [...new Set(entries.map((e) => e.path))];
  const untracked = await untrackedFiles(wt.repo, wt.root, new Set(indexed));
  const files = new Set<string>();
  // git refuses the whole add when any pathspec is beyond a symlink.
  for (const p of paths) refuseBeyondLink(wt, p);
  for (const p of paths) {
    const hits = [...indexed.filter((q) => under(p, q)), ...untracked.filter((q) => under(p, q))];
    if (hits.length === 0) staleChange(shown);
    for (const h of hits) files.add(h);
  }
  let out = entries;
  for (const f of files) out = withEntry(out, f, await entryOfFile(wt, f));
  return out;
}

/** `git restore --staged -- <paths>`: each back to HEAD's entry, or out (`rm --cached` while unborn). */
async function restoreStaged(wt: WriteWt, entries: IndexEntry[], paths: string[], shown: string[], head: string | null): Promise<IndexEntry[]> {
  const headFiles: Map<string, FileEntry> = head ? await listFiles(wt.repo, head) : new Map();
  const indexed = [...new Set(entries.map((e) => e.path))];
  const current = stage0Of(entries);
  const targets = new Set<string>();
  for (const p of paths) {
    const hits = [...indexed.filter((q) => under(p, q)), ...[...headFiles.keys()].filter((q) => under(p, q))];
    if (hits.length === 0) staleChange(shown);
    for (const h of hits) targets.add(h);
  }
  let out = entries;
  for (const f of targets) {
    const h = headFiles.get(f);
    out = withEntry(out, f, h ? keepStat(current, { path: f, mode: h.mode, oid: h.oid, stage: 0 }) : null);
  }
  return out;
}

/** `git add -A`: every path `git status` lists (a rename's source too). */
export async function addAll(wt: WriteWt, entries: IndexEntry[]): Promise<IndexEntry[]> {
  let out = entries;
  for (const s of await statusEntries(wt.repo, wt.root)) for (const p of s.origPath ? [s.path, s.origPath] : [s.path]) out = withEntry(out, p, await entryOfFile(wt, p));
  return out;
}

const verb = (stage: boolean) => (stage ? 'stage' : 'unstage');

function stagePaths(stage: boolean, paths: string[], oldPaths: string[]): WriteIntent<null> {
  return {
    kind: 'stage',
    label: () => `${verb(stage)} ${filesLabel(paths)}`,
    class: 'immediate',
    undo: () => null,
    allowedInProgress: true,
    staging: 'step',
    run: async (cx) => {
      if (paths.length === 0) fail('InvalidInput', `Nothing to ${verb(stage)}`);
      const all = [...paths, ...oldPaths];
      const entries = await loadIndex(cx.wt);
      const head = cx.before.head.oid;
      const next = stage ? await addPaths(cx.wt, entries, all, paths) : await restoreStaged(cx.wt, entries, all, paths, head);
      await saveIndex(cx.wt, next);
      cx.touch('index');
      cx.command(...(stage ? ['add', '-A'] : head ? ['restore', '--staged'] : ['rm', '--cached', '-f', '-q', '-r']), '--pathspec-from-file=-', '--pathspec-file-nul');
      return null;
    },
  };
}

function stageAll(stage: boolean): WriteIntent<null> {
  return {
    kind: 'stage',
    label: () => `${verb(stage)} all`,
    class: 'immediate',
    undo: () => null,
    allowedInProgress: true,
    staging: 'step',
    run: async (cx) => {
      const entries = await loadIndex(cx.wt);
      const head = cx.before.head.oid;
      let next: IndexEntry[];
      if (stage) next = await addAll(cx.wt, entries);
      else if (head) {
        const current = stage0Of(entries);
        next = [...(await listFiles(cx.wt.repo, head)).entries()].map(([path, e]) => keepStat(current, { path, mode: e.mode, oid: e.oid, stage: 0 }));
      } else next = [];
      await saveIndex(cx.wt, next);
      cx.touch('index');
      cx.command(...(stage ? ['add', '-A'] : head ? ['restore', '--staged', '--', ':/'] : ['rm', '--cached', '-f', '-q', '-r', '--', ':/']));
      return null;
    },
  };
}

/** `what`: "a hunk", "3 lines", counted when the request came in, from the diff the user saw. */
function stagePatch(path: string, staged: boolean, selection: StageSelection, base: WipBase, what: string): WriteIntent<null> {
  const v = verb(!staged);
  return {
    kind: 'stage',
    label: () => `${v} ${what} in ${path}`,
    class: 'immediate',
    undo: () => null,
    allowedInProgress: true,
    staging: 'step',
    run: async (cx) => {
      const wt = cx.wt;
      // §7.3 step 1: under the lock, the diff again; a base that moved is Stale.
      const d = await checkedDiff(wt, path, staged, base);
      const entries = await loadIndex(wt);
      const entry = stage0Of(entries).get(path) ?? null;
      const head = cx.before.head.oid ? ((await listFiles(wt.repo, cx.before.head.oid)).get(path) ?? null) : null;
      const file = await worktreeFile(wt.repo, wt.root, path);
      const side = entry ? latin1(await readBlobBytes(wt.repo, entry.oid)) : '';
      const applied = applySelection(splitLines(side), d.hunks, selection, staged ? 'reverse' : 'forward');
      if (!applied) {
        // patch.rs's `mode_only`: no hunks, and an `old mode` line (both sides there, modes apart).
        const modeOnly = d.hunks.length === 0 && (staged ? !!head && !!entry && head.mode !== entry.mode : !!entry && !!file && entry.mode !== file.mode);
        fail('InvalidInput', modeOnly ? "Only the file's mode changed: stage the whole file" : d.hunks.length === 0 ? `No changes to ${v} in ${path}` : 'No changed lines are selected');
      }
      // The whole of a new file unstaged, or of a deleted file staged: the entry goes.
      const gone = applied.allPicked && (staged ? head === null : file === null);
      let next: IndexEntry | null = null;
      if (!gone) {
        const oid = await writeBlobBytes(wt.repo, latin1Bytes(applied.lines.join('')));
        // A hunk never carries the file's mode (patch.rs review I1): the entry keeps its own; a new
        // entry takes the side it comes from.
        const mode = entry?.mode ?? (staged ? head!.mode : file!.mode);
        const stat = file && file.oid === oid && file.mode === mode ? statOf(wt, path) : null;
        next = { path, mode, oid, stage: 0, ...(stat ? { stat } : {}) };
      }
      await saveIndex(wt, withEntry(entries, path, next));
      cx.touch('index');
      cx.command('apply', '--cached', '--recount', '--whitespace=nowarn', ...(staged ? ['-R'] : []), '-');
      return null;
    },
  };
}

export const stageHandlers: Pick<HandlerTable, 'stage' | 'unstage' | 'stageAll' | 'unstageAll' | 'stagePatch'> = {
  stage: async ({ repo, worktree, paths }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, stagePaths(true, paths, [])),
  unstage: async ({ repo, worktree, paths, oldPaths }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, stagePaths(false, paths, oldPaths ?? [])),
  stageAll: async ({ repo, worktree }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, stageAll(true)),
  unstageAll: async ({ repo, worktree }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, stageAll(false)),
  // Refused (Stale, binary, a folder, …) before the write is queued; `run` checks again.
  stagePatch: async ({ repo, worktree, path, staged, selection, base }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    const what = selectionLabel((await checkedDiff(wt, path, staged, base)).hunks, selection, staged ? 'reverse' : 'forward');
    return runWrite(ctx, repo, worktree, NO_EXPECT, stagePatch(path, staged, selection, base, what));
  },
};
