import * as git from 'isomorphic-git';
import { blobId, compareBytewise, utf8Bytes } from './bytes';
import { readIndex, statMatches, type IndexEntry } from './indexFile';
import { MODE_EXEC, MODE_FILE, MODE_LINK, readBlobBytes } from './trees';
import { fail, igNoCache, isGbError, lstatOrNull, readTextOrNull, type ReadRepo } from './seam';

const HFS_IGNORABLE = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;

/** A path component that names the git directory on some filesystem (git's `is_ntfs_dotgit`/`is_hfs_dotgit`). */
export function isDotgit(name: string): boolean {
  const n = name.replace(HFS_IGNORABLE, '').replace(/[. ]+$/, '').replace(/[A-Z]/g, (c) => c.toLowerCase());
  return n === '.git' || n === 'git~1';
}

/** `blob.rs`'s `check_relative`: relative, no empty, `.`, `..` or `.git` segment, no NUL. */
export function checkRelative(rel: string): void {
  const bad = rel === '' || rel.includes('\0') || rel.startsWith('/') || rel.split('/').some((s) => s === '' || s === '.' || s === '..' || isDotgit(s));
  if (bad) fail('InvalidInput', `path is outside the worktree: ${JSON.stringify(rel)}`);
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const s of path.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return `/${out.join('/')}`;
}

/** The real path of `rel` inside `root` (`blob.rs`'s `safe_join`): parent folders walked, a symlinked one
 *  followed and checked; the last component is never followed. */
export async function safeJoin(repo: ReadRepo, root: string, rel: string): Promise<string> {
  checkRelative(rel);
  const outside = () => fail('InvalidInput', `path is outside the worktree: ${JSON.stringify(rel)}`);
  const parts = rel.split('/');
  const rootParts = normalize(root).split('/').filter(Boolean);
  // Resolve like canonicalize: one component at a time, every symlink followed (hop-limited), so a chain
  // of links can't slip past a per-link check. `real` never holds a link, so each lstat is of a real dir.
  let real: string[] = [...rootParts];
  let pending = [...parts.slice(0, -1)].reverse(); // a stack of components still to resolve
  let hops = 0;
  while (pending.length) {
    const comp = pending.pop() as string;
    if (comp === '' || comp === '.') continue;
    if (comp === '..') {
      real.pop();
      continue;
    }
    const path = `/${[...real, comp].join('/')}`;
    const st = await lstatOrNull(repo, path);
    if (!st) fail('NotFound', `${rel} not found in the worktree`);
    if (st.isSymbolicLink()) {
      if (++hops > 40) outside();
      const target = await repo.fs.promises.readlink(path);
      if (target.startsWith('/')) real = [];
      pending.push(...target.split('/').reverse());
    } else if (st.isDirectory()) {
      real.push(comp);
    } else {
      fail('NotFound', `${rel} not found in the worktree`);
    }
  }
  if (real.length < rootParts.length || rootParts.some((p, i) => real[i] !== p)) outside();
  if (real.slice(rootParts.length).some(isDotgit)) outside();
  return `/${[...real, parts[parts.length - 1]].join('/')}`;
}

export interface WorktreeFile {
  mode: number;
  /** A file's bytes, or a symlink's target. */
  bytes: Uint8Array;
  /** Their blob id, as `hash-object` gives it without filters. */
  oid: string;
  size: number;
}

/** What git would read at `rel`: a file or a symlink; null when nothing is there, or a folder. */
export async function worktreeFile(repo: ReadRepo, root: string, rel: string): Promise<WorktreeFile | null> {
  let abs: string;
  try {
    abs = await safeJoin(repo, root, rel);
  } catch (e) {
    if (isGbError(e) && e.kind === 'NotFound') return null;
    throw e;
  }
  const st = await lstatOrNull(repo, abs);
  if (!st) return null;
  if (st.isSymbolicLink()) {
    const bytes = utf8Bytes(await repo.fs.promises.readlink(abs));
    return { mode: MODE_LINK, bytes, oid: await blobId(bytes), size: bytes.length };
  }
  if (!st.isFile()) return null;
  const bytes = await repo.fs.promises.readFile(abs);
  return { mode: st.mode & 0o111 ? MODE_EXEC : MODE_FILE, bytes, oid: await blobId(bytes), size: bytes.length };
}

/** A tracked file that git's stat check finds as the index recorded it (`statMatches`): it holds the
 *  entry's blob, and isn't read. False when it must be read to tell, or isn't there. */
export async function unchangedSinceIndex(repo: ReadRepo, root: string, e: IndexEntry, indexMtimeMs: number | null): Promise<boolean> {
  if (!e.stat || indexMtimeMs === null) return false;
  let abs: string;
  try {
    abs = await safeJoin(repo, root, e.path);
  } catch (err) {
    if (isGbError(err)) return false;
    throw err;
  }
  const st = await lstatOrNull(repo, abs);
  return st !== null && statMatches(e, st, indexMtimeMs);
}

/** `tree.rs`'s `path_kind`: from metadata alone; a path outside the worktree is `InvalidInput`. */
export async function pathKind(repo: ReadRepo, root: string, rel: string): Promise<'file' | 'dir' | null> {
  let abs: string;
  try {
    abs = await safeJoin(repo, root, rel);
  } catch (e) {
    if (isGbError(e) && e.kind === 'NotFound') return null;
    throw e;
  }
  const st = await lstatOrNull(repo, abs);
  return st === null ? null : st.isDirectory() ? 'dir' : 'file';
}

export async function untrackedFiles(repo: ReadRepo, root: string, tracked: Set<string>): Promise<string[]> {
  const out: string[] = [];
  const io = igNoCache(repo);
  // The demo has no global core.excludesFile; .gitignore files and info/exclude are all there is.
  const ignored = (filepath: string) => git.isIgnored({ fs: io.fs, dir: root, gitdir: repo.gitdir, filepath });
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? `${root}/${rel}` : root;
    for (const name of await repo.fs.promises.readdir(abs)) {
      if (name === '.git') continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = await lstatOrNull(repo, `${abs}/${name}`);
      if (!st) continue;
      if (st.isDirectory()) {
        if (tracked.has(path)) continue; // a submodule's checkout
        if (await ignored(path + '/')) continue; // git doesn't descend into an ignored folder
        if (await lstatOrNull(repo, `${abs}/${name}/.git`)) continue; // a nested repository
        await walk(path);
      } else if (!tracked.has(path) && !(await ignored(path))) {
        out.push(path);
      }
    }
  };
  await walk('');
  return out.sort(compareBytewise);
}

export interface GitModule {
  name: string;
  path: string;
  url: string | null;
}

/** A config value as git reads it: quotes group (and protect `#`/`;`), `\"` and `\\` escape, an unquoted
 *  `#`/`;` starts a comment, and trailing space outside quotes goes. */
function configValue(raw: string): string {
  let out = '';
  let quoted = false;
  let keep = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      keep = out.length;
    } else if (c === '"') {
      quoted = !quoted;
      keep = out.length;
    } else if (!quoted && (c === '#' || c === ';')) break;
    else {
      out += c;
      if (quoted || !/\s/.test(c)) keep = out.length;
    }
  }
  return out.slice(0, keep);
}

export function parseGitmodules(text: string): GitModule[] {
  const out: GitModule[] = [];
  let cur: GitModule | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const section = /^\[\s*submodule\s+"((?:[^"\\]|\\.)*)"\s*\]\s*(?:[#;].*)?$/i.exec(line);
    const legacy = section ? null : /^\[\s*submodule\.([^\]\s]+)\s*\]\s*(?:[#;].*)?$/i.exec(line);
    if (section || legacy) {
      cur = { name: section ? section[1].replace(/\\(.)/g, '$1') : legacy![1], path: '', url: null };
      out.push(cur);
      continue;
    }
    if (line.startsWith('[')) {
      cur = null;
      continue;
    }
    const kv = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (!cur || !kv) continue;
    const key = kv[1].toLowerCase();
    if (key === 'path') cur.path = configValue(kv[2]);
    else if (key === 'url') cur.url = configValue(kv[2]);
  }
  return out.filter((m) => m.path !== '');
}

/** The worktree's `.gitmodules`, else the index's copy, else none. */
export async function gitmodules(repo: ReadRepo, root: string): Promise<GitModule[]> {
  const text = await readTextOrNull(repo, `${root}/.gitmodules`);
  if (text !== null) return parseGitmodules(text);
  const entry = (await readIndex(repo, repo.gitdir)).find((e) => e.path === '.gitmodules' && e.stage === 0);
  return entry ? parseGitmodules(new TextDecoder().decode(await readBlobBytes(repo, entry.oid))) : [];
}

/** The git dir of the repository checked out at `rel` (its `.git` folder, or where its `.git` file
 *  points), or null when nothing is checked out there. */
export async function nestedGitdir(repo: ReadRepo, root: string, rel: string): Promise<string | null> {
  const dir = `${root}/${rel}`;
  if (!(await lstatOrNull(repo, dir))?.isDirectory()) return null;
  const dotgit = await lstatOrNull(repo, `${dir}/.git`);
  let gitdir: string | null = null;
  if (dotgit?.isDirectory()) gitdir = `${dir}/.git`;
  else if (dotgit?.isFile()) {
    const text = (await readTextOrNull(repo, `${dir}/.git`))?.trim() ?? '';
    const target = text.startsWith('gitdir:') ? text.slice(7).trim() : '';
    if (target) gitdir = normalize(target.startsWith('/') ? target : `${dir}/${target}`);
  }
  if (!gitdir || !(await lstatOrNull(repo, `${gitdir}/HEAD`))) return null;
  return gitdir;
}

/** The commit checked out at `rel` (a submodule), or null when it isn't initialised. */
export async function nestedHead(repo: ReadRepo, root: string, rel: string): Promise<string | null> {
  const gitdir = await nestedGitdir(repo, root, rel);
  if (!gitdir) return null;
  try {
    return await git.resolveRef({ fs: igNoCache(repo).fs, gitdir, ref: 'HEAD' });
  } catch {
    return null;
  }
}
