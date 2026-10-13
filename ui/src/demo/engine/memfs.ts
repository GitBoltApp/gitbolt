// An in-memory file system for isomorphic-git: exactly the `fs.promises` calls it makes (readFile,
// writeFile, mkdir, rmdir, unlink, stat, lstat, readdir, readlink, symlink), with Node's error
// codes. No `rm`: isomorphic-git then removes trees itself through rmdir and unlink. Paths are
// absolute and POSIX. The `*Sync` methods are the demo's own reads and its bundle loader.

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const MAX_LINKS = 40;

interface Meta { mode: number; ino: number; mtimeMs: number; ctimeMs: number }
interface FileNode extends Meta { kind: 'file'; data: Uint8Array }
interface DirNode extends Meta { kind: 'dir'; children: Map<string, FsNode> }
interface LinkNode extends Meta { kind: 'symlink'; target: string }
type FsNode = FileNode | DirNode | LinkNode;

export interface MemStats {
  mode: number;
  size: number;
  ino: number;
  dev: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export type ReadOptions = string | { encoding?: string | null } | null | undefined;
export type WriteOptions = string | { encoding?: string | null; mode?: number } | null | undefined;

export interface FsPromises {
  readFile(path: string, opts?: ReadOptions): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, opts?: WriteOptions): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<MemStats>;
  lstat(path: string): Promise<MemStats>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
}

export interface DemoFs { readonly promises: FsPromises }

export function fsError(code: string, op: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${op} '${path}'`), { code });
}

/** `path`'s components, `.` and `..` resolved. Only absolute paths. */
export function splitPath(path: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/')) throw fsError('EINVAL', 'resolve', String(path));
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}

export const normalisePath = (path: string): string => `/${splitPath(path).join('/')}`;

export function parentOf(path: string): string {
  const parts = splitPath(path);
  parts.pop();
  return `/${parts.join('/')}`;
}

const encodingOf = (o: ReadOptions | WriteOptions) => (typeof o === 'string' ? o : (o?.encoding ?? null));

function stats(node: FsNode): MemStats {
  const size = node.kind === 'file' ? node.data.length : node.kind === 'symlink' ? new TextEncoder().encode(node.target).length : 0;
  return {
    mode: node.mode, size, ino: node.ino, dev: 1, uid: 1, gid: 1, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs,
    isFile: () => node.kind === 'file',
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => node.kind === 'symlink',
  };
}

export class MemFs implements DemoFs {
  readonly promises: FsPromises;
  private readonly now: () => number;
  private nextIno = 1;
  private readonly root: DirNode;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.root = { kind: 'dir', children: new Map(), ...this.meta(S_IFDIR | 0o755) };
    // Async functions: a bad argument rejects instead of throwing, as isomorphic-git's promise-fs
    // detection (`readFile()` with no arguments) expects.
    this.promises = {
      readFile: async (path, opts) => this.readFileSync(path, opts),
      writeFile: async (path, data, opts) => { this.writeFileSync(path, data, opts); },
      mkdir: async (path) => { this.mkdirSync(path); },
      rmdir: async (path) => { this.rmdirSync(path); },
      unlink: async (path) => { this.unlinkSync(path); },
      stat: async (path) => this.statSync(path),
      lstat: async (path) => this.lstatSync(path),
      readdir: async (path) => this.readdirSync(path),
      readlink: async (path) => this.readlinkSync(path),
      symlink: async (target, path) => { this.symlinkSync(target, path); },
    };
  }

  private meta(mode: number): Meta {
    const t = this.now();
    return { mode, ino: this.nextIno++, mtimeMs: t, ctimeMs: t };
  }

  /** The node at `path`, following symbolic links on the way, and at the end when `follow`. */
  private find(path: string, follow: boolean, depth = 0): FsNode | null {
    const parts = splitPath(path);
    let node: FsNode = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (node.kind !== 'dir') return null;
      const next = node.children.get(parts[i]);
      if (!next) return null;
      if (next.kind === 'symlink' && (follow || i < parts.length - 1)) {
        if (depth >= MAX_LINKS) throw fsError('ELOOP', 'resolve', path);
        const base = `/${parts.slice(0, i).join('/')}`;
        const target = next.target.startsWith('/') ? next.target : `${base}/${next.target}`;
        const rest = parts.slice(i + 1).join('/');
        return this.find(rest ? `${target}/${rest}` : target, follow, depth + 1);
      }
      node = next;
    }
    return node;
  }

  private parent(path: string, op: string): { dir: DirNode; name: string } {
    const parts = splitPath(path);
    const name = parts.pop();
    if (name === undefined) throw fsError('EEXIST', op, path);
    const dir = this.find(`/${parts.join('/')}`, true);
    if (!dir) throw fsError('ENOENT', op, path);
    if (dir.kind !== 'dir') throw fsError('ENOTDIR', op, path);
    return { dir, name };
  }

  readFileSync(path: string, opts?: ReadOptions): Uint8Array | string {
    const node = this.find(path, true);
    if (!node) throw fsError('ENOENT', 'open', path);
    if (node.kind !== 'file') throw fsError('EISDIR', 'read', path);
    return encodingOf(opts) ? new TextDecoder().decode(node.data) : node.data.slice();
  }

  writeFileSync(path: string, data: Uint8Array | string, opts?: WriteOptions): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    const mode = typeof opts === 'object' && opts !== null ? opts.mode : undefined;
    const existing = this.find(path, true);
    if (existing?.kind === 'dir') throw fsError('EISDIR', 'open', path);
    if (existing?.kind === 'file') {
      existing.data = bytes;
      // Into a later second than the last write: isomorphic-git compares times in whole seconds,
      // so a same-size rewrite within one would look unchanged to status and its index cache.
      existing.mtimeMs = existing.ctimeMs = Math.max(this.now(), (Math.floor(existing.mtimeMs / 1000) + 1) * 1000);
      if (mode !== undefined) existing.mode = S_IFREG | (mode & 0o777);
      return;
    }
    const { dir, name } = this.parent(path, 'open');
    dir.children.set(name, { kind: 'file', data: bytes, ...this.meta(S_IFREG | ((mode ?? 0o644) & 0o777)) });
  }

  mkdirSync(path: string): void {
    const { dir, name } = this.parent(path, 'mkdir');
    if (dir.children.has(name)) throw fsError('EEXIST', 'mkdir', path);
    dir.children.set(name, { kind: 'dir', children: new Map(), ...this.meta(S_IFDIR | 0o755) });
  }

  mkdirpSync(path: string): void {
    let at = '';
    for (const part of splitPath(path)) {
      at += `/${part}`;
      const node = this.find(at, true);
      if (!node) this.mkdirSync(at);
      else if (node.kind !== 'dir') throw fsError('ENOTDIR', 'mkdir', at);
    }
  }

  rmdirSync(path: string): void {
    const { dir, name } = this.parent(path, 'rmdir');
    const node = dir.children.get(name);
    if (!node) throw fsError('ENOENT', 'rmdir', path);
    if (node.kind !== 'dir') throw fsError('ENOTDIR', 'rmdir', path);
    if (node.children.size > 0) throw fsError('ENOTEMPTY', 'rmdir', path);
    dir.children.delete(name);
  }

  unlinkSync(path: string): void {
    const { dir, name } = this.parent(path, 'unlink');
    const node = dir.children.get(name);
    if (!node) throw fsError('ENOENT', 'unlink', path);
    if (node.kind === 'dir') throw fsError('EISDIR', 'unlink', path);
    dir.children.delete(name);
  }

  statSync(path: string): MemStats {
    const node = this.find(path, true);
    if (!node) throw fsError('ENOENT', 'stat', path);
    return stats(node);
  }

  lstatSync(path: string): MemStats {
    const node = this.find(path, false);
    if (!node) throw fsError('ENOENT', 'lstat', path);
    return stats(node);
  }

  readdirSync(path: string): string[] {
    const node = this.find(path, true);
    if (!node) throw fsError('ENOENT', 'scandir', path);
    if (node.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', path);
    return [...node.children.keys()];
  }

  readlinkSync(path: string): string {
    const node = this.find(path, false);
    if (!node) throw fsError('ENOENT', 'readlink', path);
    if (node.kind !== 'symlink') throw fsError('EINVAL', 'readlink', path);
    return node.target;
  }

  symlinkSync(target: string, path: string): void {
    const { dir, name } = this.parent(path, 'symlink');
    if (dir.children.has(name)) throw fsError('EEXIST', 'symlink', path);
    dir.children.set(name, { kind: 'symlink', target, ...this.meta(S_IFLNK | 0o777) });
  }

  existsSync(path: string, follow = true): boolean {
    try {
      return this.find(path, follow) !== null;
    } catch {
      return false;
    }
  }
}

/** `fs` with some files read and written elsewhere: a linked worktree's HEAD and index, which
 * isomorphic-git (no `commondir` support) looks for in the common git dir. */
export function redirected(fs: DemoFs, map: ReadonlyMap<string, string>): DemoFs {
  const to = (path: string) => {
    const p = normalisePath(path);
    return map.get(p) ?? p;
  };
  const f = fs.promises;
  return {
    promises: {
      readFile: async (path, opts) => f.readFile(to(path), opts),
      writeFile: async (path, data, opts) => f.writeFile(to(path), data, opts),
      mkdir: async (path) => f.mkdir(to(path)),
      rmdir: async (path) => f.rmdir(to(path)),
      unlink: async (path) => f.unlink(to(path)),
      stat: async (path) => f.stat(to(path)),
      lstat: async (path) => f.lstat(to(path)),
      readdir: async (path) => f.readdir(to(path)),
      readlink: async (path) => f.readlink(to(path)),
      symlink: async (target, path) => f.symlink(target, to(path)),
    },
  };
}
