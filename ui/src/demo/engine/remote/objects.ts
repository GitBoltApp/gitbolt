// Objects between the demo's git dirs (plan 4): what fetch and push copy. A git dir with
// `objects/info/alternates` borrows another's objects (Orbital's origin borrows the repo's, so the
// bundle carries them once); isomorphic-git doesn't read alternates, so presence and reads try
// each in turn. Reads and writes are 1b's and phase 3's, on a read view of each git dir.
import * as git from 'isomorphic-git';
import type { DemoContext } from '../../context';
import { normalisePath, type FsPromises, type MemFs } from '../memfs';
import { parseTagObject, readCommitHeaders } from '../objects';
import { parseCommit } from '../read/commitText';
import { ig, isNotFound, fail, type ReadFs, type ReadRepo, viewOf } from '../read/seam';
import { MODE_GITLINK, modeType, readRaw, readTree } from '../read/trees';
import { readRefFiles } from '../refs';
import { repoAt } from '../repo';
import { writeRawObject } from '../writeSeam';
import { netOf } from './network';

const views = new WeakMap<MemFs, Map<string, ReadRepo>>();

/** A read view of `gitdir`: a repository's own (its caches) when it's one's, else one kept per git
 *  dir (an origin has no `DemoRepo`). Its caches hold objects and pack indexes, which never change. */
function viewAt(fs: MemFs, gitdir: string): ReadRepo {
  const repo = repoAt(fs, gitdir);
  if (repo) return viewOf(repo);
  let byDir = views.get(fs);
  if (!byDir) views.set(fs, (byDir = new Map()));
  let view = byDir.get(gitdir);
  if (!view) byDir.set(gitdir, (view = { name: gitdir, dir: gitdir, gitdir, fs: fs as unknown as ReadFs, cache: {}, memo: new Map(), demo: null }));
  return view;
}

const borrowing = new WeakMap<MemFs, Map<string, ReadRepo>>();

/** A view of `gitdir` that reads the objects it borrows too (its alternates' loose objects and
 *  packs), and writes into `gitdir` itself: what a write made on the origin by the forge (a merge,
 *  a rebase) reads and writes through. */
export async function borrowingView(fs: MemFs, gitdir: string): Promise<ReadRepo> {
  let byDir = borrowing.get(fs);
  if (!byDir) borrowing.set(fs, (byDir = new Map()));
  const hit = byDir.get(gitdir);
  if (hit) return hit;
  const chained = (await chain(fs, gitdir)).slice(1);
  const lenders = chained.map((g) => `${g}/objects`);
  const own = `${gitdir}/objects`;
  const f = fs.promises;
  // A path in `gitdir`'s objects, as each lender's; null for any other path.
  const elsewhere = (path: string): string[] | null => {
    const p = normalisePath(path);
    return p === own || p.startsWith(`${own}/`) ? lenders.map((l) => l + p.slice(own.length)) : null;
  };
  const firstOf = async <T>(path: string, read: (p: string) => Promise<T>): Promise<T> => {
    try {
      return await read(path);
    } catch (e) {
      for (const p of elsewhere(path) ?? []) {
        try {
          return await read(p);
        } catch {
          // not this lender's
        }
      }
      throw e;
    }
  };
  const view: FsPromises = {
    ...f,
    readFile: (path, opts) => firstOf(path, (p) => f.readFile(p, opts)),
    stat: (path) => firstOf(path, (p) => f.stat(p)),
    lstat: (path) => firstOf(path, (p) => f.lstat(p)),
    readdir: async (path) => {
      const names = new Set<string>();
      let found = false;
      for (const p of [path, ...(elsewhere(path) ?? [])]) {
        try {
          for (const n of await f.readdir(p)) names.add(n);
          found = true;
        } catch {
          // missing here
        }
      }
      return found ? [...names] : f.readdir(path);
    },
  };
  const cache = sharedPacks(fs, own, chained.map((g) => ({ objects: `${g}/objects`, cache: viewAt(fs, g).cache })));
  const repo: ReadRepo = { name: gitdir, dir: gitdir, gitdir, fs: { promises: view } as unknown as ReadFs, cache, memo: new Map(), demo: null };
  byDir.set(gitdir, repo);
  return repo;
}

/** isomorphic-git's cache for a borrowing view (`own`: its objects folder). A borrowed pack's index
 *  (isomorphic-git keeps them in a Map under its `PackfileCache` symbol, by `.idx` path) is its
 *  lender's: kept in the lender's cache at the lender's path, so the pack is loaded once whichever
 *  view reads it first. Should isomorphic-git rename the symbol, the view keeps its own (a copy). */
function sharedPacks(fs: MemFs, own: string, lenders: { objects: string; cache: object }[]): object {
  const packs = `${own}/pack/`;
  // The lender's cache and path a pack index is kept at; null for one of `own`'s.
  const lent = (path: string) => {
    if (!path.startsWith(packs) || fs.existsSync(path)) return null;
    const name = path.slice(packs.length);
    const l = lenders.find((x) => fs.existsSync(`${x.objects}/pack/${name}`));
    return l ? { cache: l.cache as Record<symbol, unknown>, path: `${l.objects}/pack/${name}` } : null;
  };
  return new Proxy({} as Record<symbol, unknown>, {
    get(mine, key) {
      if (typeof key !== 'symbol' || key.description !== 'PackfileCache') return Reflect.get(mine, key);
      const at = (c: Record<symbol, unknown>) => (c[key] ??= new Map()) as Map<string, unknown>;
      const map = {
        get: (path: string) => {
          const l = lent(path);
          return l ? at(l.cache).get(l.path) : at(mine).get(path);
        },
        set: (path: string, value: unknown) => {
          const l = lent(path);
          if (l) at(l.cache).set(l.path, value);
          else at(mine).set(path, value);
          return map;
        },
      };
      return map;
    },
  });
}

export async function alternatesOf(fs: MemFs, gitdir: string): Promise<string[]> {
  let text: string;
  try {
    text = (await fs.promises.readFile(`${gitdir}/objects/info/alternates`, 'utf8')) as string;
  } catch {
    return [];
  }
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((objects) => {
    const abs = objects.startsWith('/') ? objects : `${gitdir}/objects/${objects}`;
    const parts: string[] = [];
    for (const p of abs.split('/')) if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p);
    return `/${parts.slice(0, -1).join('/')}`; // the git dir holding that objects folder
  });
}

/** `gitdir`, then the git dirs it borrows from, depth first (a cycle stops after five levels). */
async function chain(fs: MemFs, gitdir: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [gitdir];
  const out = [gitdir];
  for (const a of await alternatesOf(fs, gitdir)) out.push(...(await chain(fs, a, depth + 1)));
  return out;
}

async function ownHas(fs: MemFs, gitdir: string, oid: string): Promise<boolean> {
  try {
    // Deflated: a loose object is found without inflating it.
    await git.readObject({ ...ig(viewAt(fs, gitdir)), oid, format: 'deflated' });
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

export async function hasObject(fs: MemFs, gitdir: string, oid: string): Promise<boolean> {
  for (const g of await chain(fs, gitdir)) if (await ownHas(fs, g, oid)) return true;
  return false;
}

/** `oid`'s type and content, and the view of the git dir in `gitdir`'s chain that holds it. */
async function locate(fs: MemFs, gitdir: string, oid: string): Promise<{ view: ReadRepo; type: string; bytes: Uint8Array }> {
  for (const g of await chain(fs, gitdir)) {
    const view = viewAt(fs, g);
    const raw = await readRaw(view, oid);
    if (raw) return { view, ...raw };
  }
  return fail('NotFound', `object ${oid} not found`);
}

export async function copyReachable(fs: MemFs, from: string, to: string, tips: string[]): Promise<number> {
  // The whole closure is read before anything is written, then written children first (a tree's
  // entries before the tree, a commit's tree and parents before the commit, a tag's target before
  // the tag): a copy that fails midway writes nothing, and `to` never holds an object whose
  // descendants are missing, which a retry would take as present and skip.
  interface Pending { type: 'blob' | 'tree' | 'commit' | 'tag'; bytes: Uint8Array; children: string[] }
  const seen = new Set<string>();
  const enter = async (oid: string): Promise<Pending | null> => {
    if (seen.has(oid) || (await hasObject(fs, to, oid))) return null;
    seen.add(oid);
    const o = await locate(fs, from, oid);
    let children: string[] = [];
    if (o.type === 'tag') children = [parseTagObject(o.bytes).object];
    else if (o.type === 'commit') {
      const h = readCommitHeaders(o.bytes);
      children = [h.tree, ...h.parents];
    } else if (o.type === 'tree') children = (await readTree(o.view, oid)).filter((e) => modeType(e.mode) !== MODE_GITLINK).map((e) => e.oid);
    return { type: o.type as Pending['type'], bytes: o.bytes, children: children.reverse() };
  };
  // Depth first, each object emitted once all its children are (an explicit stack: a long history
  // would overflow a recursive walk).
  const order: Pending[] = [];
  const stack: Pending[] = [];
  for (const tip of tips) {
    const first = await enter(tip);
    if (first) stack.push(first);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const next = top.children.pop();
      if (next === undefined) order.push(stack.pop()!);
      else {
        const child = await enter(next);
        if (child) stack.push(child);
      }
    }
  }
  const into = viewAt(fs, to);
  for (const o of order) await writeRawObject(into, o.type, o.bytes);
  return order.length;
}

export async function readCommitIn(fs: MemFs, gitdir: string, oid: string): Promise<{ tree: string; parent: string[]; message: string }> {
  const o = await locate(fs, gitdir, oid);
  if (o.type !== 'commit') fail('InvalidInput', `not a commit: ${oid}`);
  const c = parseCommit(o.bytes);
  return { tree: c.tree, parent: c.parents, message: c.rawMessage };
}

export async function peelIn(fs: MemFs, gitdir: string, oid: string): Promise<string> {
  let at = oid;
  for (let hops = 0; hops < 10; hops++) {
    const o = await locate(fs, gitdir, at);
    if (o.type !== 'tag') return at;
    at = parseTagObject(o.bytes).object;
  }
  return at;
}

export async function remoteRefs(ctx: DemoContext, fs: MemFs, gitdir: string): Promise<Map<string, string>> {
  const files = readRefFiles(fs, gitdir);
  const byName = new Map(files.map((f) => [f.full, f]));
  const out = new Map<string, string>();
  for (const f of files) {
    let at: typeof f | undefined = f;
    for (let hops = 0; at?.symref && hops < 5; hops++) at = byName.get(at.symref);
    if (at?.oid) out.set(f.full, at.oid);
  }
  for (const source of netOf(ctx).virtualRefs) for (const [n, o] of await source(fs, gitdir)) out.set(n, o);
  return out;
}
