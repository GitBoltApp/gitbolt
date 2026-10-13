import * as git from 'isomorphic-git';
import { compareBytewise } from './bytes';
import { readCommit } from './commitText';
import { readRaw } from './trees';
import { demoOf, fail, ig, isNotFound, type ReadRepo } from './seam';
import { worktreeOf } from './worktrees';

/** A ref name as git resolves it (`refs/<n>`, `refs/tags/<n>`, `refs/heads/<n>`, `refs/remotes/<n>`,
 *  `refs/remotes/<n>/HEAD`; `HEAD` the main worktree's), through 1a's refs. Null when there's none. */
export async function resolveRefName(repo: ReadRepo, name: string): Promise<string | null> {
  const demo = demoOf(repo);
  const refs = demo.refMap();
  if (name === 'HEAD') return demo.head(refs).target;
  for (const full of [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]) {
    const oid = demo.resolveRef(refs, full);
    if (oid) return oid;
  }
  return null;
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

/** The core's `relation`: commits reachable from `a` and not `b`, and the reverse (1a's `aheadBehind`). */
export async function relation(repo: ReadRepo, a: string, b: string): Promise<[number, number]> {
  const demo = demoOf(repo);
  await demo.addCommits([a, b]);
  return demo.aheadBehind(a, b);
}

export async function mergeBaseOf(repo: ReadRepo, a: string, b: string): Promise<string | null> {
  try {
    const bases = await git.findMergeBase({ ...ig(repo), oids: [a, b] });
    return (bases[0] as string | undefined) ?? null;
  } catch {
    return null;
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
