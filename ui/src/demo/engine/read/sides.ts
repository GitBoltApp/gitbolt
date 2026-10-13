import type { BlobSource } from '../../../api/gen/BlobSource';
import type { LfsSide } from '../../../api/gen/LfsSide';
import { AttrReader, worktreeEncoding } from './attributes';
import { lossyUtf8, utf8Bytes } from './bytes';
import { gitSubject, parseOid, readCommitOrNull } from './commitText';
import { cachedObject, parsePointer, POINTER_MAX, usesLfs, type Pointer } from './lfs';
import { entryAt, isTreeMode, MODE_GITLINK, readRaw } from './trees';
import { fail, lstatOrNull, subRepo, type ReadRepo } from './seam';
import { gitmodules, nestedGitdir, safeJoin } from './worktree';
import { worktreeRoot } from './worktrees';

export type Side =
  | { kind: 'absent' }
  | { kind: 'object'; oid: string }
  | { kind: 'submodule'; oid: string }
  | { kind: 'atCommit'; commit: string }
  | { kind: 'worktree'; root: string; encoding: string | null; lfs: boolean };

export type Resolved =
  | { kind: 'blob'; oid: string }
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string; encoding: string | null }
  | { kind: 'link'; path: string }
  | { kind: 'lfs'; file: string; pointer: Pointer; raw: Uint8Array }
  | { kind: 'lfsMissing'; pointer: Pointer; raw: Uint8Array };

export async function resolveSource(repo: ReadRepo, path: string, src: BlobSource): Promise<Side> {
  switch (src.kind) {
    case 'absent':
      return { kind: 'absent' };
    case 'object':
      return { kind: 'object', oid: parseOid(src.oid) };
    case 'submodule':
      return { kind: 'submodule', oid: parseOid(src.oid) };
    case 'atCommit':
      return { kind: 'atCommit', commit: parseOid(src.commit) };
    case 'worktree': {
      const root = await worktreeRoot(repo, src.worktree);
      await safeJoin(repo, root, path);
      const attrs = await new AttrReader(repo, root).get(path);
      return { kind: 'worktree', root, encoding: worktreeEncoding(attrs), lfs: attrs.get('filter') === 'lfs' };
    }
  }
}

/** The repository of the submodule at `path`: the one `.gitmodules` registers, else a checkout at `path`. */
async function openSubmodule(repo: ReadRepo, path: string): Promise<ReadRepo | null> {
  const registered = (await gitmodules(repo, repo.dir)).find((m) => m.path === path);
  if (registered) {
    const modules = `${repo.gitdir}/modules/${registered.name}`;
    if (await lstatOrNull(repo, `${modules}/HEAD`)) return subRepo(repo, `${repo.dir}/${path}`, modules);
  }
  const gitdir = await nestedGitdir(repo, repo.dir, path);
  return gitdir ? subRepo(repo, `${repo.dir}/${path}`, gitdir) : null;
}

export async function submoduleText(repo: ReadRepo, path: string, oid: string): Promise<string> {
  const sub = await openSubmodule(repo, path);
  const c = sub ? await readCommitOrNull(sub, oid) : null;
  const subject = c ? gitSubject(c.rawMessage).trim() : '';
  return subject ? `Subproject commit ${oid}\n${subject}\n` : `Subproject commit ${oid}\n`;
}

async function resolveStored(repo: ReadRepo, path: string, side: Side): Promise<Resolved | null> {
  switch (side.kind) {
    case 'absent':
      return null;
    case 'object':
      return { kind: 'blob', oid: side.oid };
    case 'submodule':
      return { kind: 'text', text: await submoduleText(repo, path, side.oid) };
    case 'atCommit': {
      if ((await readRaw(repo, side.commit))?.type !== 'commit') fail('NotFound', `commit ${side.commit} not found`);
      const e = await entryAt(repo, side.commit, path);
      if (!e || isTreeMode(e.mode)) fail('NotFound', `${path} does not exist at ${side.commit}`);
      return e.mode === MODE_GITLINK ? { kind: 'text', text: await submoduleText(repo, path, e.oid) } : { kind: 'blob', oid: e.oid };
    }
    case 'worktree': {
      const file = await safeJoin(repo, side.root, path);
      const st = await lstatOrNull(repo, file);
      if (!st) fail('NotFound', `${path} not found in the worktree`);
      if (st.isSymbolicLink()) return { kind: 'link', path: file };
      if (st.isFile()) return { kind: 'file', path: file, encoding: side.encoding };
      return fail('InvalidInput', `${path} is not a file`);
    }
  }
}

/** A small blob or file that is an LFS pointer, in a repository that uses LFS, reads as its stored file. */
async function lfsReal(repo: ReadRepo, r: Resolved): Promise<Resolved> {
  let raw: Uint8Array;
  if (r.kind === 'blob') {
    const obj = await readRaw(repo, r.oid);
    if (!obj || obj.type !== 'blob' || obj.bytes.length >= POINTER_MAX) return r;
    raw = obj.bytes;
  } else if (r.kind === 'file') {
    const st = await lstatOrNull(repo, r.path);
    if (!st || st.size > POINTER_MAX - 1) return r;
    raw = await repo.fs.promises.readFile(r.path);
  } else {
    return r;
  }
  const pointer = parsePointer(raw);
  if (!pointer || !(await usesLfs(repo))) return r;
  const file = await cachedObject(repo, pointer);
  return file ? { kind: 'lfs', file, pointer, raw } : { kind: 'lfsMissing', pointer, raw };
}

export async function resolve(repo: ReadRepo, path: string, side: Side): Promise<Resolved | null> {
  const r = await resolveStored(repo, path, side);
  return r ? lfsReal(repo, r) : null;
}

export async function sizeOf(repo: ReadRepo, r: Resolved): Promise<number> {
  switch (r.kind) {
    case 'blob': {
      const obj = await readRaw(repo, r.oid);
      if (!obj) fail('NotFound', `object ${r.oid} not found`);
      if (obj.type !== 'blob') fail('NotFound', `${r.oid} is not a file`);
      return obj.bytes.length;
    }
    case 'text':
      return utf8Bytes(r.text).length;
    case 'file':
      return (await repo.fs.promises.lstat(r.path)).size;
    case 'link':
      return utf8Bytes(await repo.fs.promises.readlink(r.path)).length;
    case 'lfs':
      return (await repo.fs.promises.lstat(r.file)).size;
    case 'lfsMissing':
      return r.raw.length;
  }
}

export async function bytesOf(repo: ReadRepo, r: Resolved, limit: number): Promise<{ bytes: Uint8Array; declared: string | null } | null> {
  const within = (bytes: Uint8Array, declared: string | null = null) => (bytes.length <= limit ? { bytes, declared } : null);
  switch (r.kind) {
    case 'blob': {
      const obj = await readRaw(repo, r.oid);
      if (!obj) fail('NotFound', `object ${r.oid} not found`);
      return { bytes: obj.bytes, declared: null };
    }
    case 'text':
      return { bytes: utf8Bytes(r.text), declared: null };
    case 'file':
      return within(await repo.fs.promises.readFile(r.path), r.encoding);
    case 'link':
      return { bytes: utf8Bytes(await repo.fs.promises.readlink(r.path)), declared: null };
    case 'lfs':
      return within(await repo.fs.promises.readFile(r.file));
    case 'lfsMissing':
      return { bytes: r.raw, declared: null };
  }
}

export function lfsSideOf(r: Resolved): LfsSide | null {
  if (r.kind !== 'lfs' && r.kind !== 'lfsMissing') return null;
  return { oid: r.pointer.oid, size: r.pointer.size, downloaded: r.kind === 'lfs', pointer: lossyUtf8(r.raw) };
}
