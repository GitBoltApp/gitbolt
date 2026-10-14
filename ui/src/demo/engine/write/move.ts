// What git does when it moves a worktree between commits (`switch`, `merge --ff-only`, `read-tree
// -m -u`) or resets it (`reset --hard`, `reset`), written from its behaviour and checked against the
// git binary (never from its source). Every path is checked before anything is written, so a refused
// move changes nothing: the core's put-back after a half-done move has nothing to do here.
import * as git from 'isomorphic-git';
import type { GbError } from '../../../api/gen/GbError';
import { gitFailure } from '../errors';
import { blobId, compareBytewise } from '../read/bytes';
import { indexMtime, statMatches, type IndexEntry } from '../read/indexFile';
import { igNoCache, lstatOrNull } from '../read/seam';
import { listFiles, MODE_GITLINK, type FileEntry } from '../read/trees';
import { checkoutEntry, fileAt, kind, readFileState, removeWorktreePath, throughLink } from './files';
import { keepStat, loadIndex, saveIndex, stage0Of, statOf } from './index';
import type { WriteWt } from './seam';
import { othersUnder } from './snapshot';

export type MoveVerb = 'checkout' | 'merge' | 'readTree';

export type Why = 'staged' | 'dirty' | 'lost' | 'untracked';

const same = (a: FileEntry | null, b: FileEntry | null): boolean => (a === null || b === null ? a === b : a.oid === b.oid && a.mode === b.mode);
const asEntry = (e: IndexEntry | undefined): FileEntry | null => (e ? { oid: e.oid, mode: e.mode } : null);
const at = (wt: WriteWt, path: string) => `${wt.root}/${path}`;
/** What stands at `path`, never looking through a symlinked folder above it (git doesn't). */
const kindAt = (wt: WriteWt, path: string) => (throughLink(wt, path) ? null : kind(wt, at(wt, path)));

export function unmergedRefusal(verb: MoveVerb, paths: string[]): GbError {
  if (verb === 'checkout') {
    const message = 'you need to resolve your current index first';
    return gitFailure(message, `error: ${message}\n${paths.map((p) => `${p}: needs merge\n`).join('')}`);
  }
  if (verb === 'merge') {
    const message = 'Merging is not possible because you have unmerged files.';
    const stderr = `error: ${message}\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\n`;
    return gitFailure(message, stderr);
  }
  const message = 'You need to resolve your current index first';
  return gitFailure(message, `fatal: ${message}\n`);
}

/** `checkout`/`merge`: one block per reason, in git's order (staged entries and modified files are
 *  separate blocks under the same words). */
const BLOCKS: { why: Why; head: (word: string) => string; tail: (doing: string) => string }[] = [
  { why: 'staged', head: (w) => `Your local changes to the following files would be overwritten by ${w}:`, tail: (d) => `Please commit your changes or stash them before you ${d}.` },
  { why: 'dirty', head: (w) => `Your local changes to the following files would be overwritten by ${w}:`, tail: (d) => `Please commit your changes or stash them before you ${d}.` },
  { why: 'lost', head: () => 'Updating the following directories would lose untracked files in them:', tail: () => '' },
  { why: 'untracked', head: (w) => `The following untracked working tree files would be overwritten by ${w}:`, tail: (d) => `Please move or remove them before you ${d}.` },
];

/** `readTree` stops at its first path. */
const ONE: Record<Why, (p: string) => string> = {
  dirty: (p) => `Entry '${p}' not uptodate. Cannot merge.`,
  staged: (p) => `Entry '${p}' would be overwritten by merge. Cannot merge.`,
  untracked: (p) => `Untracked working tree file '${p}' would be overwritten by merge.`,
  lost: (p) => `Updating '${p}' would lose untracked files in it`,
};

/** The order git walks the trees and the index in: a folder sorts as `name/`, except where a file of
 *  the same name is in one of them (a file/folder clash), when both sort at `name`. */
function walkKey(files: Set<string>): (path: string) => string {
  return (path) => {
    const parts = path.split('/');
    let key = parts[0];
    for (let i = 1; i < parts.length; i++) key += (files.has(parts.slice(0, i).join('/')) ? '\0' : '/') + parts[i];
    return key;
  };
}

export function refusal(verb: MoveVerb, problems: Map<string, Why>, key: (path: string) => string): GbError {
  const paths = [...problems.keys()].sort((a, b) => compareBytewise(key(a), key(b)));
  if (verb === 'readTree') {
    const say = ONE[problems.get(paths[0])!](paths[0]);
    return gitFailure(say, `error: ${say}\n`);
  }
  const [word, doing] = verb === 'checkout' ? ['checkout', 'switch branches'] : ['merge', 'merge'];
  const blocks = BLOCKS.map((b) => ({ ...b, paths: paths.filter((p) => problems.get(p) === b.why) })).filter((b) => b.paths.length > 0);
  const stderr = blocks.map((b) => `error: ${b.head(word)}\n${b.paths.map((p) => `\t${p}\n`).join('')}${b.tail(doing)}\n`).join('') + 'Aborting\n';
  return gitFailure(blocks[0].head(word), stderr);
}

export function ignoredPath(wt: WriteWt, path: string): Promise<boolean> {
  const io = igNoCache(wt.repo);
  return git.isIgnored({ fs: io.fs, dir: wt.root, gitdir: wt.repo.gitdir, filepath: path });
}

/** Whether the worktree holds `e` at `path`: by the index entry's stat data where git would trust it
 *  (racy entries never are: Review Focus 2), else read and hashed. A gitlink: its folder isn't compared. */
async function holds(wt: WriteWt, path: string, e: FileEntry, cur: IndexEntry | undefined, indexMs: number | null): Promise<boolean> {
  if (e.mode === MODE_GITLINK) return true;
  if (cur && same(asEntry(cur), e)) {
    const st = await lstatOrNull(wt.repo, at(wt, path));
    if (st && statMatches(cur, st, indexMs)) return true;
  }
  const f = readFileState(wt, path);
  return f !== null && f.mode === e.mode && (await blobId(f.bytes)) === e.oid;
}

/** Empties the folder `path` (everything in it, ignored files and empty folders too) for a file to take its place. */
export function clearFolder(wt: WriteWt, path: string): void {
  const walk = (abs: string) => {
    for (const name of wt.fs.readdirSync(abs) as string[]) {
      const p = `${abs}/${name}`;
      if (kind(wt, p) === 'dir') {
        walk(p);
        wt.fs.rmdirSync(p);
      } else wt.fs.unlinkSync(p);
    }
  };
  walk(at(wt, path));
}

/** The folders above `path`, outermost first. */
export const foldersOf = (path: string): string[] => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));

/** `git switch` (`checkout`), `git merge --ff-only` (`merge`), `git read-tree -m -u` (`readTree`) from
 *  the tree-ish `from` (null: unborn) to the tree-ish `to`: the worktree paths it wrote or removed, sorted. */
export async function twoWayMove(wt: WriteWt, from: string | null, to: string, verb: MoveVerb): Promise<string[]> {
  const indexMs = await indexMtime(wt.repo, wt.gitdir);
  const entries = await loadIndex(wt);
  const unmerged = [...new Set(entries.filter((e) => e.stage !== 0).map((e) => e.path))];
  if (unmerged.length > 0) throw unmergedRefusal(verb, unmerged);
  const head = from === null ? new Map<string, FileEntry>() : await listFiles(wt.repo, from);
  const target = await listFiles(wt.repo, to);
  const index = stage0Of(entries);
  const paths = [...new Set([...head.keys(), ...target.keys(), ...index.keys()])].filter((p) => !same(head.get(p) ?? null, target.get(p) ?? null)).sort(compareBytewise);
  const problems = new Map<string, Why>();
  const refuse = (path: string, why: Why) => {
    if (!problems.has(path)) problems.set(path, why);
  };
  const indexed = new Set(index.keys());
  /** A folder holding an untracked file that isn't ignored. */
  const holdsUntracked = async (dir: string): Promise<boolean> => {
    for (const f of othersUnder(wt, dir, indexed)) if (!(await ignoredPath(wt, f))) return true;
    return false;
  };
  const moved: string[] = [];
  for (const p of paths) {
    const h = head.get(p) ?? null;
    const t = target.get(p) ?? null;
    const cur = index.get(p);
    if (same(asEntry(cur), t)) continue;
    if (!same(asEntry(cur), h)) refuse(p, 'staged');
    else if (h !== null) {
      const k = kindAt(wt, p);
      // Behind a symlinked folder: a local change when something is reached there, else missing.
      if (k === null) {
        if (throughLink(wt, p) && kind(wt, at(wt, p)) !== null) refuse(p, 'dirty');
        else moved.push(p);
      } else if (k === 'dir' && h.mode !== MODE_GITLINK) refuse(p, !t && (await holdsUntracked(p)) ? 'lost' : 'dirty');
      else if (k !== 'dir' && !(await holds(wt, p, h, cur, indexMs))) refuse(p, 'dirty');
      else moved.push(p);
    } else if (fileAt(wt, p) !== null && !(await ignoredPath(wt, p))) refuse(p, 'untracked');
    else moved.push(p);
  }
  // Folders the target replaces by a file, and files where it needs a folder.
  const leaving = new Set(moved.filter((p) => !target.has(p)));
  const dropped: string[] = [];
  for (const p of moved) {
    const e = target.get(p);
    if (!e) continue;
    if (e.mode !== MODE_GITLINK && kindAt(wt, p) === 'dir') {
      // A populated gitlink's folder replaced by a file is refused here (its checkout's files look
      // untracked); git removes it. No demo repository has a populated submodule.
      if (await holdsUntracked(p)) refuse(p, 'lost');
      // Staged files neither commit has: dropped when they're as staged, else local changes.
      for (const f of indexed) {
        if (!f.startsWith(`${p}/`) || head.has(f) || target.has(f)) continue;
        if (fileAt(wt, f) === null || (await holds(wt, f, asEntry(index.get(f))!, index.get(f), indexMs))) dropped.push(f);
        else refuse(f, 'dirty');
      }
    }
    for (const up of foldersOf(p)) {
      const k = kindAt(wt, up);
      if (k === null || k === 'dir' || leaving.has(up) || problems.has(up)) continue;
      // A staged file there counts as untracked unless it's ignored, when it goes, entry and all.
      if (!(await ignoredPath(wt, up))) refuse(up, 'untracked');
      else if (index.has(up) && !dropped.includes(up)) dropped.push(up);
    }
  }
  if (problems.size > 0) throw refusal(verb, problems, walkKey(new Set([...head.keys(), ...target.keys(), ...indexed])));
  for (const p of [...leaving, ...dropped]) removeWorktreePath(wt, p);
  const replaced = new Set([...moved, ...dropped]);
  const next = entries.filter((e) => !replaced.has(e.path));
  for (const p of moved) {
    const e = target.get(p);
    if (!e) continue;
    // Ignored files under a folder the target replaces go with it.
    if (e.mode !== MODE_GITLINK && kindAt(wt, p) === 'dir') clearFolder(wt, p);
    const stat = await checkoutEntry(wt, p, e);
    next.push({ path: p, mode: e.mode, oid: e.oid, stage: 0, ...(stat ? { stat } : {}) });
  }
  await saveIndex(wt, next);
  return [...replaced].sort(compareBytewise);
}

/** `git reset --hard <to>` (a tree-ish; null: the empty tree): the worktree paths it wrote or removed. */
export async function hardReset(wt: WriteWt, to: string | null): Promise<string[]> {
  const indexMs = await indexMtime(wt.repo, wt.gitdir);
  const entries = await loadIndex(wt);
  const target = to === null ? new Map<string, FileEntry>() : await listFiles(wt.repo, to);
  const current = stage0Of(entries);
  const changed = new Set<string>();
  // Removals first, so a folder the target puts a file in is empty by then.
  for (const p of [...new Set(entries.map((e) => e.path))].sort(compareBytewise)) {
    if (target.has(p) || fileAt(wt, p) === null) continue;
    removeWorktreePath(wt, p);
    changed.add(p);
  }
  const next: IndexEntry[] = [];
  for (const [p, e] of target) {
    const k = kindAt(wt, p);
    const there = e.mode === MODE_GITLINK ? k === 'dir' : k !== null && k !== 'dir' && (await holds(wt, p, e, current.get(p), indexMs));
    if (!there) {
      // A folder in the way goes, whatever it holds (git's reset --hard does the same).
      if (k === 'dir' && e.mode !== MODE_GITLINK) clearFolder(wt, p);
      await checkoutEntry(wt, p, e);
      changed.add(p);
    }
    const stat = statOf(wt, p);
    next.push({ path: p, mode: e.mode, oid: e.oid, stage: 0, ...(stat ? { stat } : {}) });
  }
  await saveIndex(wt, next);
  return [...changed].sort(compareBytewise);
}

/** `git reset -q <to> [-- <paths>]` (a tree-ish; null: the empty tree): the index only; `paths`
 *  literal files or folders. */
export async function mixedReset(wt: WriteWt, to: string | null, paths: string[] | null = null): Promise<void> {
  const entries = await loadIndex(wt);
  const target = to === null ? new Map<string, FileEntry>() : await listFiles(wt.repo, to);
  const inScope = (p: string) => paths === null || paths.some((q) => p === q || p.startsWith(`${q}/`));
  const current = stage0Of(entries);
  const next = entries.filter((e) => !inScope(e.path));
  for (const [p, e] of target) if (inScope(p)) next.push(keepStat(current, { path: p, mode: e.mode, oid: e.oid, stage: 0 }));
  await saveIndex(wt, next);
}
