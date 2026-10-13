import { lossyUtf8, strictUtf8 } from './bytes';
import { AttrReader } from './attributes';
import { readIndex } from './indexFile';
import { readRaw } from './trees';
import { configString } from './revs';
import { lstatOrNull, readTextOrNull, type ReadRepo } from './seam';
import { checkRelative } from './worktree';

/** git-lfs never treats a blob this large or larger as a pointer (its `blobSizeCutoff`). */
export const POINTER_MAX = 1024;
const VERSIONS = ['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1'];

export interface Pointer {
  oid: string;
  size: number;
}

export function parsePointer(bytes: Uint8Array): Pointer | null {
  if (bytes.length >= POINTER_MAX) return null;
  const text = strictUtf8(bytes);
  if (text === null) return null;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const clean = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const version = clean[0]?.startsWith('version ') ? clean[0].slice(8) : null;
  if (version === null || !VERSIONS.includes(version)) return null;
  let oid: string | null = null;
  let size: number | null = null;
  for (const line of clean.slice(1)) {
    const sp = line.indexOf(' ');
    if (sp < 0) return null;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === '' || !/^[a-z0-9.-]+$/.test(key)) return null;
    if (key === 'oid') {
      if (!value.startsWith('sha256:')) return null;
      oid = value.slice(7);
    } else if (key === 'size') {
      if (!/^\d+$/.test(value)) return null;
      size = Number(value);
    }
  }
  if (oid === null || !/^[0-9a-f]{64}$/.test(oid) || size === null) return null;
  return { oid, size };
}

/** The patterns of a `.gitattributes` text's lines that route files through LFS, in order. */
export function lfsPatterns(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('#'))
    .flatMap((l) => {
      const [pattern, ...words] = l.split(/\s+/);
      return pattern && words.includes('filter=lfs') ? [pattern] : [];
    });
}

export async function topPatterns(repo: ReadRepo, root: string): Promise<string[]> {
  const text = await readTextOrNull(repo, `${root}/.gitattributes`);
  return text === null ? [] : lfsPatterns(text);
}

export async function lfsStorage(repo: ReadRepo): Promise<string> {
  const s = (await configString(repo, 'lfs.storage'))?.trim();
  if (!s) return `${repo.gitdir}/lfs`;
  return s.startsWith('/') ? s : `${repo.gitdir}/${s}`;
}

/** The core's `uses_lfs`: a `.gitattributes` in the index, the worktree's top one or `info/attributes`
 *  routes files through LFS, or the LFS store holds objects. */
export async function usesLfs(repo: ReadRepo): Promise<boolean> {
  for (const e of await readIndex(repo, repo.gitdir)) {
    if (e.path !== '.gitattributes' && !e.path.endsWith('/.gitattributes')) continue;
    const raw = await readRaw(repo, e.oid);
    if (raw && lfsPatterns(lossyUtf8(raw.bytes)).length > 0) return true;
  }
  for (const f of [`${repo.dir}/.gitattributes`, `${repo.gitdir}/info/attributes`]) {
    const text = await readTextOrNull(repo, f);
    if (text !== null && lfsPatterns(text).length > 0) return true;
  }
  try {
    return (await repo.fs.promises.readdir(`${await lfsStorage(repo)}/objects`)).length > 0;
  } catch {
    return false;
  }
}

/** The real file of `p` in the local store, when it's there in full (a regular file of the right size). */
export async function cachedObject(repo: ReadRepo, p: Pointer): Promise<string | null> {
  const path = `${await lfsStorage(repo)}/objects/${p.oid.slice(0, 2)}/${p.oid.slice(2, 4)}/${p.oid}`;
  const st = await lstatOrNull(repo, path);
  return st?.isFile() && st.size === p.size ? path : null;
}

export async function filterConfigured(repo: ReadRepo): Promise<boolean> {
  return (await configString(repo, 'filter.lfs.process')) !== undefined || (await configString(repo, 'filter.lfs.smudge')) !== undefined;
}

/** Which of `paths` LFS stores, by the worktree's attributes (`check-attr filter`). */
export async function lfsTracked(repo: ReadRepo, root: string, paths: string[]): Promise<string[]> {
  for (const p of paths) checkRelative(p);
  const attrs = new AttrReader(repo, root);
  const out: string[] = [];
  for (const p of paths) if ((await attrs.get(p)).get('filter') === 'lfs') out.push(p);
  return out;
}
