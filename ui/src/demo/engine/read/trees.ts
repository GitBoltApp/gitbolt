import * as git from 'isomorphic-git';
import { compareBytewise } from './bytes';
import { fail, ig, isNotFound, lruOf, type ReadRepo } from './seam';

export const MODE_TREE = 0o040000;
export const MODE_FILE = 0o100644;
export const MODE_EXEC = 0o100755;
export const MODE_LINK = 0o120000;
export const MODE_GITLINK = 0o160000;

export function modeType(mode: number): number {
  return mode & 0o170000;
}

export function isTreeMode(mode: number): boolean {
  return modeType(mode) === MODE_TREE;
}

export interface FileEntry {
  oid: string;
  mode: number;
}

export interface TreeEntry extends FileEntry {
  name: string;
}

/** One path that differs between two trees; `null` where a side has no file there. */
export interface TreeChange {
  path: string;
  old: FileEntry | null;
  new: FileEntry | null;
}

export async function readRaw(repo: ReadRepo, oid: string): Promise<{ type: string; bytes: Uint8Array } | null> {
  try {
    const r = await git.readObject({ ...ig(repo), oid, format: 'content' });
    return { type: r.type, bytes: r.object as Uint8Array };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function readBlobBytes(repo: ReadRepo, oid: string): Promise<Uint8Array> {
  const raw = await readRaw(repo, oid);
  if (!raw) fail('NotFound', `object ${oid} not found`);
  return raw.bytes;
}

const TREES_CACHE = 4096;

/** A tree's id and entries in stored order; a commit id reads its tree. Kept by tree id (a commit
 *  id remembers which tree it peeled to) in an LRU: objects never change. */
async function resolveTree(repo: ReadRepo, treeish: string): Promise<{ id: string; entries: TreeEntry[] }> {
  const trees = lruOf<TreeEntry[]>(repo, 'trees', TREES_CACHE);
  const peeled = lruOf<string>(repo, 'trees:peeled', TREES_CACHE);
  const id = peeled.get(treeish) ?? treeish;
  const hit = trees.get(id);
  if (hit) return { id, entries: hit };
  const { oid, tree } = await git.readTree({ ...ig(repo), oid: id });
  if (oid !== id) peeled.set(id, oid);
  const entries = tree.map((e) => ({ name: e.path, mode: parseInt(e.mode, 8), oid: e.oid }));
  trees.set(oid, entries);
  return { id: oid, entries };
}

/** A tree's entries in stored order; a commit id reads its tree. */
export async function readTree(repo: ReadRepo, treeish: string): Promise<TreeEntry[]> {
  return (await resolveTree(repo, treeish)).entries;
}

/** The entry at `path` (a file, link, gitlink or tree), or null. */
export async function entryAt(repo: ReadRepo, treeish: string, path: string): Promise<FileEntry | null> {
  const parts = path.split('/');
  let tree = treeish;
  for (let i = 0; i < parts.length; i++) {
    const e = (await readTree(repo, tree)).find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return { oid: e.oid, mode: e.mode };
    if (!isTreeMode(e.mode)) return null;
    tree = e.oid;
  }
  return null;
}

const FILES_CACHE = 16;

/** Every non-tree entry under `treeish`, by full path, in bytewise order. A small LRU keeps the last few trees'. */
export async function listFiles(repo: ReadRepo, treeish: string): Promise<Map<string, FileEntry>> {
  const lru = lruOf<Map<string, FileEntry>>(repo, 'files', FILES_CACHE);
  const root = await resolveTree(repo, treeish);
  const hit = lru.get(root.id);
  if (hit) return hit;
  const out = new Map<string, FileEntry>();
  const walk = async (tree: string, prefix: string): Promise<void> => {
    for (const e of await readTree(repo, tree)) {
      if (isTreeMode(e.mode)) await walk(e.oid, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
    }
  };
  await walk(root.id, '');
  const sorted = new Map([...out.entries()].sort(([x], [y]) => compareBytewise(x, y)));
  lru.set(root.id, sorted);
  return sorted;
}

/** The files that differ between `a` and `b` (either may be null: the empty tree), sorted bytewise.
 *  Equal subtrees are skipped; a file replaced by a folder is the file's deletion plus the folder's files. */
export async function diffTrees(repo: ReadRepo, a: string | null, b: string | null): Promise<TreeChange[]> {
  const out: TreeChange[] = [];
  const walk = async (x: string | null, y: string | null, prefix: string): Promise<void> => {
    if (x === y) return;
    const xs = x ? await readTree(repo, x) : [];
    const ys = y ? await readTree(repo, y) : [];
    const byName = new Map<string, [TreeEntry | null, TreeEntry | null]>();
    for (const e of xs) byName.set(e.name, [e, null]);
    for (const e of ys) {
      const pair = byName.get(e.name);
      if (pair) pair[1] = e;
      else byName.set(e.name, [null, e]);
    }
    for (const [name, [o, n]] of byName) {
      const path = `${prefix}${name}`;
      const oTree = o && isTreeMode(o.mode) ? o.oid : null;
      const nTree = n && isTreeMode(n.mode) ? n.oid : null;
      if (oTree !== null || nTree !== null) await walk(oTree, nTree, `${path}/`);
      const oFile = o && !isTreeMode(o.mode) ? { oid: o.oid, mode: o.mode } : null;
      const nFile = n && !isTreeMode(n.mode) ? { oid: n.oid, mode: n.mode } : null;
      if (!oFile && !nFile) continue;
      if (oFile && nFile && oFile.oid === nFile.oid && oFile.mode === nFile.mode) continue;
      out.push({ path, old: oFile, new: nFile });
    }
  };
  await walk(a, b, '');
  return out.sort((x, y) => compareBytewise(x.path, y.path));
}
