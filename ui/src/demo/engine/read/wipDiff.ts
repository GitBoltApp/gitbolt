// A WIP file's hunks (`hunks.rs`: `base_of`, `path_facts`, `wip_diff`) and why some files have none
// (`patch.rs`'s `Parsed::refusal`). The core reads `git diff -U3` and parses it; here the same patch is
// modelled as git would print it (its sections, header modes, binary line and size) from `unifiedHunks`.
import type { Hunk } from '../../../api/gen/Hunk';
import type { WipBase } from '../../../api/gen/WipBase';
import { AttrReader, binaryByAttr } from './attributes';
import { isBinaryHead, latin1, utf8Bytes } from './bytes';
import { nestedDirty } from './changes';
import { readIndex } from './indexFile';
import { lfsTracked } from './lfs';
import { diffLines, splitLines, unifiedHunks, type DiffHunk } from './lineDiff';
import { entryAt, isTreeMode, MODE_GITLINK, MODE_LINK, modeType, readBlobBytes } from './trees';
import { fail, isGbError, lstatOrNull, type ReadRepo, type ReadStat } from './seam';
import { checkRelative, nestedHead, safeJoin, worktreeFile } from './worktree';
import { worktreeOf } from './worktrees';

export const HUNKS_LIMIT = 5 * 1024 * 1024;
export const CONFLICTED = 'Resolve the conflict first';
export const LFS_WHOLE = 'Stored with Git LFS: stage the whole file';
export const TOO_LARGE = 'Too large for line staging; stage the whole file';
export const TYPECHANGE = "The file's type changed: stage the whole file";
export const SUBMODULE = 'Submodule: stage the whole file';
export const SYMLINK = 'Symlink: stage the whole file';
export const BINARY = 'Binary file: stage the whole file';

export interface WipDiff {
  hunks: DiffHunk[];
}

interface SideNow {
  mode: number;
  oid: string;
  /** A worktree file's bytes (a symlink's target); else the blob is read. */
  bytes?: Uint8Array;
  /** A submodule checkout at the recorded commit with changes of its own (git's `-dirty`). */
  dirty?: boolean;
}

/** One `diff --git` section, as the core's patch parser reads it. */
interface Section {
  /** The modes its header names. */
  modes: number[];
  binary: boolean;
  hunks: DiffHunk[];
  /** The bytes of its text. */
  size: number;
}

async function statOrNull(repo: ReadRepo, root: string, path: string): Promise<ReadStat | null> {
  try {
    return await lstatOrNull(repo, await safeJoin(repo, root, path));
  } catch (e) {
    if (isGbError(e) && e.kind === 'NotFound') return null;
    throw e;
  }
}

export async function baseOf(repo: ReadRepo, root: string, path: string): Promise<WipBase> {
  checkRelative(path);
  const wt = await worktreeOf(repo, root);
  const h = wt.head ? await entryAt(repo, wt.head, path) : null;
  const index = (await readIndex(repo, wt.gitdir)).find((e) => e.path === path && e.stage === 0);
  const file = await worktreeFile(repo, root, path);
  return { head: h && !isTreeMode(h.mode) ? h.oid : null, index: index?.oid ?? null, worktree: file?.oid ?? null };
}

/** A side's text as git diffs it: a gitlink is its `Subproject commit` line. */
async function contentOf(repo: ReadRepo, side: SideNow | null): Promise<{ text: string; binary: boolean }> {
  if (!side) return { text: '', binary: false };
  if (side.mode === MODE_GITLINK) return { text: `Subproject commit ${side.oid}${side.dirty ? '-dirty' : ''}\n`, binary: false };
  const bytes = side.bytes ?? (await readBlobBytes(repo, side.oid));
  return { text: latin1(bytes), binary: isBinaryHead(bytes) };
}

const range = (start: number, n: number) => String(start).length + (n === 1 ? 0 : 1 + String(n).length);

/** The section git prints for `old` → `now` (one side may be missing). Its size counts every byte but a
 *  hunk header's function name, and takes git's 7-character abbreviated ids. */
async function section(repo: ReadRepo, path: string, old: SideNow | null, now: SideNow | null, binaryAttr: boolean): Promise<Section> {
  const p = utf8Bytes(path).length;
  const sameId = !!old && !!now && old.oid === now.oid;
  const modes = !old ? [now!.mode] : !now ? [old.mode] : old.mode !== now.mode ? [old.mode, now.mode] : sameId ? [] : [old.mode];
  let size = 17 + 2 * p; // diff --git a/P b/P
  if (!old) size += 21; // new file mode M
  else if (!now) size += 25; // deleted file mode M
  else if (old.mode !== now.mode) size += 32; // old mode M, new mode M
  if (!sameId) size += 23 + (old && now && old.mode === now.mode ? 7 : 0); // index a..b[ M]
  const a = await contentOf(repo, old);
  const b = await contentOf(repo, now);
  if (a.text === b.text) return { modes, binary: false, hunks: [], size };
  const name = (side: SideNow | null) => (side ? 2 + p : 9); // a/P or /dev/null
  if (a.binary || b.binary || binaryAttr) return { modes, binary: true, hunks: [], size: size + 26 + name(old) + name(now) };
  const al = splitLines(a.text);
  const bl = splitLines(b.text);
  const hunks = unifiedHunks(al, bl, diffLines(al, bl), 3);
  size += 10 + name(old) + name(now); // --- a/P, +++ b/P
  for (const h of hunks) {
    size += 10 + range(h.oldStart, h.oldLines) + range(h.newStart, h.newLines);
    for (const l of h.lines) size += 1 + l.text.length + (l.noEol ? 29 : 0);
  }
  return { modes, binary: false, hunks, size };
}

/** The unstaged side of a gitlink: what `git diff --submodule=short` compares the index's commit with. */
async function checkout(repo: ReadRepo, root: string, path: string, stage0: SideNow, stat: ReadStat | null): Promise<SideNow | null> {
  if (!stat) return null; // `deleted file mode 160000`
  if (!stat.isDirectory()) return worktreeFile(repo, root, path); // a file or link in its place
  const head = await nestedHead(repo, root, path);
  if (!head) return stage0; // not checked out: no change
  if (head !== stage0.oid) return { mode: MODE_GITLINK, oid: head };
  return (await nestedDirty(repo, root, path)).modified ? { ...stage0, dirty: true } : stage0;
}

/** The `-U3` hunks of `path` (`staged`: HEAD → index, else index → worktree), or why it has none to stage
 *  by hunk or line. */
export async function wipDiff(repo: ReadRepo, root: string, path: string, staged: boolean): Promise<WipDiff | string> {
  checkRelative(path);
  const wt = await worktreeOf(repo, root);
  const headEntry = wt.head ? await entryAt(repo, wt.head, path) : null;
  const index = await readIndex(repo, wt.gitdir);
  const atPath = index.filter((e) => e.path === path);
  const under = index.some((e) => e.path.startsWith(`${path}/`));
  const stat = await statOrNull(repo, root, path);
  const gitlink = atPath.some((e) => e.mode === MODE_GITLINK) || headEntry?.mode === MODE_GITLINK;
  const folder = !gitlink && ((headEntry !== null && isTreeMode(headEntry.mode)) || (atPath.length === 0 && under) || stat?.isDirectory() === true);
  if (folder) fail('InvalidInput', `${path} is not a file`);
  if (!headEntry && atPath.length === 0 && !stat) fail('NotFound', `${path} not found`);
  if (atPath.length > 0 && atPath.every((e) => e.stage !== 0)) return CONFLICTED;
  // git diffs an LFS file's pointers, not the file the diff view shows.
  if ((await lfsTracked(repo, root, [path])).length > 0) return LFS_WHOLE;
  if (!staged && stat?.isFile() && stat.size > HUNKS_LIMIT) return TOO_LARGE;

  const stage0 = atPath.find((e) => e.stage === 0) ?? null;
  let old: SideNow | null;
  let now: SideNow | null;
  if (staged) {
    old = headEntry && !isTreeMode(headEntry.mode) ? headEntry : null;
    now = stage0;
  } else if (!stage0) {
    // Untracked: the core's `git diff --no-index /dev/null <path>`, which fails when nothing is there.
    if (!stat) fail('Other', `Could not access '${path}'`);
    old = null;
    now = await worktreeFile(repo, root, path);
  } else {
    old = stage0;
    now = stage0.mode === MODE_GITLINK ? await checkout(repo, root, path, stage0, stat) : await worktreeFile(repo, root, path);
  }
  if (!old && !now) return { hunks: [] };
  if (old && now && old.oid === now.oid && old.mode === now.mode && !now.dirty) return { hunks: [] };
  const binaryAttr = binaryByAttr(await new AttrReader(repo, root).get(path));
  // A type change is two sections: the old file deleted, the new one added.
  const sections =
    old && now && modeType(old.mode) !== modeType(now.mode)
      ? [await section(repo, path, old, null, binaryAttr), await section(repo, path, null, now, binaryAttr)]
      : [await section(repo, path, old, now, binaryAttr)];
  if (sections.reduce((n, s) => n + s.size, 0) > HUNKS_LIMIT) return TOO_LARGE;
  const modes = sections.flatMap((s) => s.modes);
  if (sections.length > 1) return TYPECHANGE;
  // A dirty checkout at the recorded commit names no mode (no `index` line), but its `Subproject commit`
  // lines still mark a submodule (`patch.rs`'s `gitlink`).
  const subprojectLine = sections.some((s) => s.hunks.some((h) => h.lines.some((l) => l.kind !== 'context' && l.text.startsWith('Subproject commit '))));
  if (modes.includes(MODE_GITLINK) || (modes.length === 0 && subprojectLine)) return SUBMODULE;
  if (modes.includes(MODE_LINK)) return SYMLINK;
  if (sections[0].binary) return BINARY;
  return { hunks: sections[0].hunks };
}

export function hunkSummary(h: DiffHunk): Hunk {
  return {
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    del: h.lines.filter((l) => l.kind === 'del').map((l) => l.old),
    add: h.lines.filter((l) => l.kind === 'add').map((l) => l.new),
  };
}
