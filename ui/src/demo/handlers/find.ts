import type { HistoryHit } from '../../api/gen/HistoryHit';
import type { DemoContext } from '../context';
import type { HandlerTable } from '../transport';
import { asciiLower } from '../engine/read/bytes';
import { gitSubject, readCommit, readCommitOrNull } from '../engine/read/commitText';
import { messageLog, pathLog } from '../engine/read/logWalk';
import { diffTrees } from '../engine/read/trees';
import { commitsByPrefix, peelToCommit, refsUnder, revParse, stashIds } from '../engine/read/revs';
import { demoOf, fail, lruOf, readRepoOf, type ReadRepo } from '../engine/read/seam';
import { listWorktrees } from '../engine/read/worktrees';

export const LOCATE_LIMIT = 10_000;
export const HISTORY_MAX = 200;
const PATH_MIN_CHARS = 2;
const SHA_MIN_CHARS = 4;

export function setFindWindow(ctx: DemoContext, repoId: number, ids: string[]): void {
  readRepoOf(ctx, repoId).memo.set('find:window', ids);
}

function windowOf(repo: ReadRepo): string[] {
  const w = repo.memo.get('find:window') as string[] | undefined;
  if (!w) fail('InvalidInput', 'load the graph before searching it');
  return w;
}

async function textOf(repo: ReadRepo, id: string): Promise<string> {
  const key = `find:text:${id}`;
  let t = repo.memo.get(key) as string | undefined;
  if (t === undefined) {
    const c = await readCommit(repo, id);
    t = `${c.summary}\n${c.body}`.toLowerCase();
    repo.memo.set(key, t);
  }
  return t;
}

async function pathsOf(repo: ReadRepo, id: string): Promise<string[]> {
  const lru = lruOf<string[]>(repo, 'find:paths', LOCATE_LIMIT);
  let p = lru.get(id);
  if (p === undefined) {
    const c = await readCommit(repo, id);
    const parent = c.parents[0] ? await readCommitOrNull(repo, c.parents[0]) : null;
    p = [...new Set((await diffTrees(repo, parent?.tree ?? null, c.tree)).map((ch) => ch.path.toLowerCase()))];
    lru.set(id, p);
  }
  return p;
}

async function historyTips(repo: ReadRepo): Promise<{ tips: string[]; stashParts: Set<string> }> {
  const tips: string[] = [];
  for (const prefix of ['refs/heads', 'refs/remotes'] as const) for (const r of await refsUnder(repo, prefix)) tips.push(r.oid);
  for (const r of await refsUnder(repo, 'refs/tags')) {
    const c = await peelToCommit(repo, r.oid);
    if (c) tips.push(c);
  }
  for (const w of await listWorktrees(repo)) if (w.head) tips.push(w.head);
  const stashParts = new Set<string>();
  for (const s of await stashIds(repo)) {
    tips.push(s);
    (await readCommitOrNull(repo, s))?.parents.slice(1).forEach((p) => stashParts.add(p));
  }
  return { tips: [...new Set(tips)], stashParts };
}

export const findHandlers: Pick<HandlerTable, 'findText' | 'findPaths' | 'locateCommit' | 'searchHistory'> = {
  findText: async ({ repo: id, query }, ctx) => {
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    const repo = readRepoOf(ctx, id);
    const window = windowOf(repo);
    const hex = q.length >= SHA_MIN_CHARS && /^[0-9a-f]+$/.test(q);
    const out: string[] = [];
    for (const c of window) if ((await textOf(repo, c)).includes(q) || (hex && c.startsWith(q))) out.push(c);
    return out;
  },
  findPaths: async ({ repo: id, query }, ctx) => {
    const q = query.trim().toLowerCase();
    if ([...q].length < PATH_MIN_CHARS) return [];
    const repo = readRepoOf(ctx, id);
    const window = windowOf(repo);
    const out: string[] = [];
    for (const c of window) if ((await pathsOf(repo, c)).some((p) => p.includes(q))) out.push(c);
    return out;
  },
  locateCommit: async ({ repo: id, sha }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const window = windowOf(repo);
    const s = sha.trim();
    let target: string | null = null;
    try {
      target = await revParse(repo, s);
    } catch {
      const ids = s.length >= SHA_MIN_CHARS && /^[0-9a-fA-F]+$/.test(s) ? await commitsByPrefix(repo, s.toLowerCase()) : [];
      if (ids.length > 1) return { found: false, limit: null, id: null, ambiguous: true };
      if (ids.length === 0) fail('NotFound', `No commit ${s}`);
      target = ids[0];
    }
    if (window.includes(target)) return { found: true, limit: null, id: target, ambiguous: false };
    const i = (await demoOf(repo).walkOrder(LOCATE_LIMIT)).indexOf(target);
    return i >= 0 ? { found: true, limit: Math.max(i + 1, window.length), id: target, ambiguous: false } : { found: false, limit: null, id: target, ambiguous: false };
  },
  searchHistory: async ({ repo: id, query }, ctx) => {
    const q = query.trim();
    if (q === '') return [];
    const repo = readRepoOf(ctx, id);
    const window = windowOf(repo);
    const { tips, stashParts } = await historyTips(repo);
    const max = HISTORY_MAX + window.length;
    const lower = asciiLower(q);
    const byMessage = await messageLog(repo, tips, q, max);
    const byPath = await pathLog(repo, tips, (p) => asciiLower(p).includes(lower), max);
    const loaded = new Set(window);
    const seen = new Set<string>();
    const hits: HistoryHit[] = [];
    for (const c of [...byMessage, ...byPath]) {
      if (loaded.has(c) || stashParts.has(c) || seen.has(c)) continue;
      seen.add(c);
      const parsed = await readCommit(repo, c);
      hits.push({ id: c, time: parsed.committer.time, author: parsed.author.name, summary: gitSubject(parsed.rawMessage) });
    }
    return hits.sort((a, b) => b.time - a.time).slice(0, HISTORY_MAX);
  },
};
