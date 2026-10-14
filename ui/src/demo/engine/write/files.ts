// Worktree files as git writes them when it checks a blob out (a regular file with its executable
// bit, a symlink, a gitlink's folder) and removes them (with the folders that leaves empty, never
// the root), and a path's state for snapshots and staging steps.
import { gbError } from '../errors';
import { fail } from '../read/seam';
import { parentOf } from '../memfs';
import { compareBytewise } from '../read/bytes';
import type { IndexStat } from '../read/indexFile';
import { MODE_EXEC, MODE_FILE, MODE_GITLINK, MODE_LINK, readBlobBytes } from '../read/trees';
import { statOf } from './index';
import type { WriteWt } from './seam';

/** A file (mode 100644 or 100755) or a symlink (120000, `bytes` its target). */
export interface FileState {
  mode: number;
  bytes: Uint8Array;
}

const at = (wt: WriteWt, path: string) => `${wt.root}/${path}`;

/** What stands at the absolute path `p` (a symlink is never followed). */
export function kind(wt: WriteWt, p: string): 'file' | 'dir' | 'link' | null {
  try {
    const st = wt.fs.lstatSync(p);
    return st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file';
  } catch {
    return null;
  }
}

export const sameFile = (a: FileState | null, b: FileState | null): boolean =>
  a === null || b === null ? a === b : a.mode === b.mode && a.bytes.length === b.bytes.length && a.bytes.every((x, i) => x === b.bytes[i]);

/** The file or link at `path`; null for a folder or nothing. */
export function readFileState(wt: WriteWt, path: string): FileState | null {
  const p = at(wt, path);
  const k = kind(wt, p);
  if (k === 'link') return { mode: MODE_LINK, bytes: new TextEncoder().encode(wt.fs.readlinkSync(p)) };
  if (k !== 'file') return null;
  return { mode: wt.fs.lstatSync(p).mode & 0o111 ? MODE_EXEC : MODE_FILE, bytes: wt.fs.readFileSync(p) as Uint8Array };
}

/** Removes empty folders from `dir` up, never the worktree's root. */
function pruneEmpty(wt: WriteWt, dir: string): void {
  for (let d = dir; d !== wt.root && d.startsWith(`${wt.root}/`); d = parentOf(d)) {
    if (kind(wt, d) !== 'dir' || wt.fs.readdirSync(d).length > 0) return;
    wt.fs.rmdirSync(d);
  }
}

/** Whether a folder above `path` is a symlink: git never looks through one, so nothing is removed
 *  or trusted there (what it points at may be outside the worktree). */
export function throughLink(wt: WriteWt, path: string): boolean {
  let p = wt.root;
  for (const part of path.split('/').slice(0, -1)) {
    p += `/${part}`;
    const k = kind(wt, p);
    if (k === 'link') return true;
    if (k !== 'dir') return false;
  }
  return false;
}

/** The file or link at `path`, never looked for through a symlinked folder (git doesn't). */
export const fileAt = (wt: WriteWt, path: string): FileState | null => (throughLink(wt, path) ? null : readFileState(wt, path));

/** `git add` of a path behind a symlinked folder: it refuses ("pathspec 'd/a.txt' is beyond a symbolic link"). */
export function refuseBeyondLink(wt: WriteWt, path: string): void {
  if (throughLink(wt, path)) fail('Other', `pathspec '${path}' is beyond a symbolic link`);
}

/** A `.git` anywhere in the real folder at `path` (precheck.rs's `repo_at`): a write that removes or
 *  replaces the path would delete that repository. Never behind a symlinked folder. */
export function repoAt(wt: WriteWt, path: string): boolean {
  return repoWithin(wt, path) !== null;
}

/** The folder at or under `path` holding a `.git` of any kind (precheck.rs's `dot_git_within`): the
 *  walk goes depth first in name order, never into a folder once its `.git` is found. */
export function repoWithin(wt: WriteWt, path: string): string | null {
  if (throughLink(wt, path) || kind(wt, at(wt, path)) !== 'dir') return null;
  const walk = (rel: string): string | null => {
    const names = (wt.fs.readdirSync(at(wt, rel)) as string[]).sort(compareBytewise);
    if (names.includes('.git')) return rel;
    for (const name of names) {
      const found = kind(wt, at(wt, `${rel}/${name}`)) === 'dir' ? walk(`${rel}/${name}`) : null;
      if (found !== null) return found;
    }
    return null;
  };
  return walk(path);
}

/** Removes what is at `path` (a file or a link; a folder only when it's empty), then the folders that
 *  leaves empty. Nothing behind a symlinked folder. */
export function removeWorktreePath(wt: WriteWt, path: string): void {
  if (throughLink(wt, path)) return;
  const p = at(wt, path);
  const k = kind(wt, p);
  if (k === null) return;
  if (k === 'dir') {
    if (wt.fs.readdirSync(p).length > 0) return;
    wt.fs.rmdirSync(p);
  } else wt.fs.unlinkSync(p);
  pruneEmpty(wt, parentOf(p));
}

/** `path`'s folders, a file or a link standing where one must be unlinked first (git does). */
function makeParents(wt: WriteWt, path: string): void {
  let p = wt.root;
  for (const part of path.split('/').slice(0, -1)) {
    p += `/${part}`;
    const k = kind(wt, p);
    if (k === 'dir') continue;
    if (k !== null) wt.fs.unlinkSync(p);
    wt.fs.mkdirSync(p);
  }
}

/** Writes `state` at `path` (an empty folder there goes; one with files in it refuses), or removes
 *  what is there when it's null. The stat data of what was written. */
export function writeFileState(wt: WriteWt, path: string, state: FileState | null): IndexStat | null {
  if (!state) {
    removeWorktreePath(wt, path);
    return null;
  }
  makeParents(wt, path);
  const p = at(wt, path);
  const k = kind(wt, p);
  if (k === 'dir' && state.mode !== MODE_GITLINK) {
    if (wt.fs.readdirSync(p).length > 0) throw gbError('DirtyWorktree', `${path} is a folder with files in it`);
    wt.fs.rmdirSync(p);
  } else if (k === 'link' || (k === 'file' && (state.mode === MODE_LINK || state.mode === MODE_GITLINK))) wt.fs.unlinkSync(p);
  if (state.mode === MODE_GITLINK) {
    if (kind(wt, p) === null) wt.fs.mkdirSync(p);
  } else if (state.mode === MODE_LINK) wt.fs.symlinkSync(new TextDecoder().decode(state.bytes), p);
  else wt.fs.writeFileSync(p, state.bytes, { mode: state.mode === MODE_EXEC ? 0o755 : 0o644 });
  return statOf(wt, path);
}

/** A stored blob checked out at `path` (a gitlink: its folder only). */
export async function checkoutEntry(wt: WriteWt, path: string, e: { mode: number; oid: string }): Promise<IndexStat | null> {
  const bytes = e.mode === MODE_GITLINK ? new Uint8Array() : await readBlobBytes(wt.repo, e.oid);
  return writeFileState(wt, path, { mode: e.mode, bytes });
}
