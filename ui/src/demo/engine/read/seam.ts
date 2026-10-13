import type * as git from 'isomorphic-git';
import type { GbErrorKind } from '../../../api/gen/GbErrorKind';
import { isGbError } from '../../../errors/describe';
import type { DemoContext } from '../../context';
import { gbError } from '../errors';
import type { DemoRepo } from '../repo';
import { lossyUtf8 } from './bytes';

export { isGbError };

export interface ReadStat {
  mode: number;
  size: number;
  /** MemFs gives both; without them git's stat check never passes, and files are hashed. */
  mtimeMs?: number;
  ino?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The part of 1a's `MemFs` promise API the read layer uses. */
export interface ReadFs {
  promises: {
    readFile(path: string): Promise<Uint8Array>;
    readdir(path: string): Promise<string[]>;
    lstat(path: string): Promise<ReadStat>;
    readlink(path: string): Promise<string>;
  };
}

/** One repository as the read layer sees it: its main worktree, its common git dir, caches of immutable
 *  things (parsed trees and commits, keyed by id), and the 1a `DemoRepo` behind it (null for a
 *  submodule's checkout, which has none). */
export interface ReadRepo {
  readonly name: string;
  readonly dir: string;
  readonly gitdir: string;
  readonly fs: ReadFs;
  readonly cache: object;
  readonly memo: Map<string, unknown>;
  readonly demo: DemoRepo | null;
}

export type IgFs = Parameters<typeof git.readObject>[0]['fs'];

/** The options every isomorphic-git object read takes. */
export function ig(repo: ReadRepo): { fs: IgFs; gitdir: string; cache: object } {
  return { fs: repo.fs as unknown as IgFs, gitdir: repo.gitdir, cache: repo.cache };
}

/** For the isomorphic-git calls that take no `cache`. */
export function igNoCache(repo: ReadRepo): { fs: IgFs; gitdir: string } {
  return { fs: repo.fs as unknown as IgFs, gitdir: repo.gitdir };
}

const views = new WeakMap<DemoRepo, ReadRepo>();

export function viewOf(demo: DemoRepo): ReadRepo {
  let view = views.get(demo);
  if (!view) {
    view = { name: demo.name, dir: demo.dir, gitdir: demo.gitdir, fs: demo.fs as unknown as ReadFs, cache: demo.cache, memo: new Map(), demo };
    views.set(demo, view);
  }
  return view;
}

export function readRepoOf(ctx: DemoContext, id: number): ReadRepo {
  return viewOf(ctx.repos.get(id));
}

export function demoOf(repo: ReadRepo): DemoRepo {
  return repo.demo ?? fail('Other', `${repo.name} has no repository handle`);
}

/** A nested repository (a submodule's checkout) on the same fs, with caches of its own. */
export function subRepo(repo: ReadRepo, dir: string, gitdir: string): ReadRepo {
  return { name: `${repo.name}:${dir}`, dir, gitdir, fs: repo.fs, cache: {}, memo: new Map(), demo: null };
}

/** A least-recently-used cache of at most `cap` values. */
export class Lru<V> {
  private readonly map = new Map<string, V>();
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value!);
  }
}

/** The LRU kept in `repo.memo` under `name`. */
export function lruOf<V>(repo: ReadRepo, name: string, cap: number): Lru<V> {
  let lru = repo.memo.get(name) as Lru<V> | undefined;
  if (!lru) repo.memo.set(name, (lru = new Lru<V>(cap)));
  return lru;
}

export function fail(kind: GbErrorKind, message: string): never {
  throw gbError(kind, message);
}

export function isNotFound(e: unknown): boolean {
  if (isGbError(e)) return e.kind === 'NotFound';
  const code = (e as { code?: string } | null)?.code;
  return code === 'NotFoundError' || code === 'ENOENT';
}

export async function lstatOrNull(repo: ReadRepo, path: string): Promise<ReadStat | null> {
  try {
    return await repo.fs.promises.lstat(path);
  } catch (e) {
    if (isNotFound(e) || (e as { code?: string }).code === 'ENOTDIR') return null;
    throw e;
  }
}

export async function readBytesOrNull(repo: ReadRepo, path: string): Promise<Uint8Array | null> {
  const st = await lstatOrNull(repo, path);
  if (!st?.isFile()) return null;
  return repo.fs.promises.readFile(path);
}

export async function readTextOrNull(repo: ReadRepo, path: string): Promise<string | null> {
  const bytes = await readBytesOrNull(repo, path);
  return bytes ? lossyUtf8(bytes) : null;
}
