import * as git from 'isomorphic-git';
import { compareBytewise } from './bytes';
import { readCommit } from './commitText';
import { readRaw } from './trees';
import { demoOf, fail, ig, isNotFound, type ReadRepo } from './seam';
import { worktreeOf } from './worktrees';

/** The full ref a name means to git (itself, `refs/<n>`, `refs/tags/<n>`, `refs/heads/<n>`,
 *  `refs/remotes/<n>`, `refs/remotes/<n>/HEAD`, the first that exists), through 1a's refs; null
 *  when there's none. */
export function dwimRefName(repo: ReadRepo, name: string): string | null {
  const demo = demoOf(repo);
  const refs = demo.refMap();
  for (const full of [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]) {
    if (demo.resolveRef(refs, full) !== null) return full;
  }
  return null;
}

/** What a ref name resolves to as git dwims it (`dwimRefName`; `HEAD` the main worktree's), not
 *  peeled. Null when there's none. */
export async function resolveRefName(repo: ReadRepo, name: string): Promise<string | null> {
  const demo = demoOf(repo);
  const refs = demo.refMap();
  if (name === 'HEAD') return demo.head(refs).target;
  const full = dwimRefName(repo, name);
  return full === null ? null : demo.resolveRef(refs, full);
}

export async function peelToCommit(repo: ReadRepo, oid: string): Promise<string | null> {
  return demoOf(repo).peelToCommit(oid);
}

export async function objectsByPrefix(repo: ReadRepo, hex: string): Promise<string[]> {
  try {
    return [await git.expandOid({ ...ig(repo), oid: hex })];
  } catch (e) {
    const err = e as { code?: string; data?: { matches?: string[] } };
    if (err.code === 'AmbiguousError') return [...new Set(err.data?.matches ?? [])];
    if (isNotFound(e)) return [];
    throw e;
  }
}

export async function commitsByPrefix(repo: ReadRepo, hex: string): Promise<string[]> {
  const out: string[] = [];
  for (const id of await objectsByPrefix(repo, hex)) if ((await readRaw(repo, id))?.type === 'commit') out.push(id);
  return out;
}

export async function revParse(repo: ReadRepo, spec: string, root?: string): Promise<string> {
  let s = spec.trim();
  for (const suffix of ['^{commit}', '^{}']) if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  const m = /^(.*?)((?:[~^][0-9]*)*)$/.exec(s);
  const base = m?.[1] ?? s;
  const ops = m?.[2] ?? '';
  let oid: string | null = null;
  if (base === 'HEAD' || base === '@') {
    oid = root ? (await worktreeOf(repo, root)).head : await resolveRefName(repo, 'HEAD');
  } else if (/^[0-9a-fA-F]{40}$/.test(base)) {
    oid = (await readRaw(repo, base.toLowerCase())) ? base.toLowerCase() : null;
  } else if (base !== '' && !base.startsWith('-')) {
    oid = await resolveRefName(repo, base);
    if (oid === null && /^[0-9a-fA-F]{4,39}$/.test(base)) {
      const all = await objectsByPrefix(repo, base.toLowerCase());
      const pick = all.length === 1 ? all : await commitsByPrefix(repo, base.toLowerCase());
      if (pick.length > 1) fail('InvalidInput', `short object ID ${base} is ambiguous`);
      oid = pick[0] ?? null;
    }
  }
  let c = oid === null ? null : await peelToCommit(repo, oid);
  if (c === null) fail('NotFound', `${spec}: no such commit`);
  for (const op of ops.match(/[~^][0-9]*/g) ?? []) {
    const n = op.length > 1 ? Number(op.slice(1)) : 1;
    if (op[0] === '~') {
      for (let k = 0; k < n; k++) c = (await readCommit(repo, c)).parents[0] ?? fail('NotFound', `${spec}: no such commit`);
    } else if (n > 0) {
      c = (await readCommit(repo, c)).parents[n - 1] ?? fail('NotFound', `${spec}: no such commit`);
    }
  }
  return c;
}

/** Every commit reachable from `tip` (1a's `reach`, after reading any commit its store lacks). */
export async function ancestors(repo: ReadRepo, tip: string): Promise<Set<string>> {
  const demo = demoOf(repo);
  await demo.addCommits([tip]);
  return demo.reach(tip);
}

/** `a` is `b` or one of its ancestors. */
export async function isAncestor(repo: ReadRepo, a: string, b: string): Promise<boolean> {
  return a === b || (await ancestors(repo, b)).has(a);
}

/** The core's `short`: an oid's first 7 bytes, or the whole string when they'd split a character
 *  (chip oids come from the request unvalidated). */
export function shortOid(oid: string): string {
  const bytes = new TextEncoder().encode(oid);
  return bytes.length <= 7 || (bytes[7] & 0xc0) === 0x80 ? oid : new TextDecoder().decode(bytes.slice(0, 7));
}

/** The core's `relation`: commits reachable from `a` and not `b`, and the reverse (1a's `aheadBehind`). */
export async function relation(repo: ReadRepo, a: string, b: string): Promise<[number, number]> {
  const demo = demoOf(repo);
  await demo.addCommits([a, b]);
  return demo.aheadBehind(a, b);
}

export async function mergeBaseOf(repo: ReadRepo, a: string, b: string): Promise<string | null> {
  return (await mergeBasesOf(repo, a, b))[0] ?? null;
}

/** Every best common ancestor of `a` and `b` (more than one after a criss-cross merge). */
export async function mergeBasesOf(repo: ReadRepo, a: string, b: string): Promise<string[]> {
  try {
    return (await git.findMergeBase({ ...ig(repo), oids: [a, b] })) as string[];
  } catch {
    return [];
  }
}

/** 1a's ref files under `prefix` (byte order, loose over packed), each resolved through symbolic refs. */
export async function refsUnder(repo: ReadRepo, prefix: 'refs/heads' | 'refs/remotes' | 'refs/tags'): Promise<{ name: string; oid: string }[]> {
  const demo = demoOf(repo);
  const files = demo.refFiles();
  const refs = demo.refMap(files);
  const out: { name: string; oid: string }[] = [];
  for (const f of files) {
    if (!f.full.startsWith(`${prefix}/`)) continue;
    const oid = demo.resolveRef(refs, f.full);
    if (oid) out.push({ name: f.full, oid });
  }
  return out.sort((x, y) => compareBytewise(x.name, y.name));
}

export async function configString(repo: ReadRepo, key: string): Promise<string | undefined> {
  return (await demoOf(repo).config(key)) ?? undefined;
}

export async function configBool(repo: ReadRepo, key: string): Promise<boolean | undefined> {
  const v = (await configString(repo, key))?.trim().toLowerCase();
  if (v === undefined) return undefined;
  if (['true', 'yes', 'on', '1', ''].includes(v)) return true;
  if (['false', 'no', 'off', '0'].includes(v)) return false;
  return undefined;
}

/** `git stash list`'s commits, newest first (1a's `stashes()`, from the stash's reflog). */
export async function stashIds(repo: ReadRepo): Promise<string[]> {
  return demoOf(repo).stashes().map((s) => s.id);
}
