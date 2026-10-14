// `git status --porcelain=v2` as the core reads it (status.rs, precheck::dirty): each changed path's
// index letter (HEAD → index) and worktree letter (index → worktree), staged renames paired, conflicts
// with git's two letters, untracked files last (ignored ones never). Built on 1b's WIP reading: the
// worktree's own HEAD tree and index, and git's stat check before a file is hashed.
import type { WipCounts } from '../../gen/WipCounts';
import { compareBytewise } from '../read/bytes';
import { nestedDirty, readWip, same, statusOf as letter, trackedFile, type Wip } from '../read/changes';
import type { IndexEntry } from '../read/indexFile';
import { pairRenames, type RenameFile } from '../read/renames';
import { lstatOrNull, type ReadRepo } from '../read/seam';
import { MODE_GITLINK, readBlobBytes, type FileEntry } from '../read/trees';
import { nestedHead, unchangedSinceIndex, untrackedFiles } from '../read/worktree';

export type StatusKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked';

export interface StatusEntry {
  path: string;
  /** A rename's source. */
  origPath: string | null;
  /** `.` unchanged, else `A` `M` `D` `T` `R`; an unmerged entry's first letter; `?` untracked. */
  index: string;
  worktree: string;
  kind: StatusKind;
}

/** The stages a conflicted path has → git's letters. */
const UNMERGED: Record<string, string> = { '123': 'UU', '23': 'AA', '1': 'DD', '2': 'AU', '3': 'UA', '13': 'DU', '12': 'UD' };

async function worktreeLetter(repo: ReadRepo, w: Wip, e: IndexEntry): Promise<string> {
  if (e.mode === MODE_GITLINK) {
    const st = await lstatOrNull(repo, `${w.path}/${e.path}`);
    if (!st) return 'D';
    if (!st.isDirectory()) return 'T';
    const head = await nestedHead(repo, w.path, e.path);
    if (head === null) return '.';
    const d = await nestedDirty(repo, w.path, e.path);
    return head !== e.oid || d.modified || d.untracked ? 'M' : '.';
  }
  if (await unchangedSinceIndex(repo, w.path, e, w.indexMtimeMs)) return '.';
  const f = await trackedFile(repo, w.path, e.path);
  return same(f, e) ? '.' : letter(e, f);
}

export async function statusEntries(repo: ReadRepo, root: string): Promise<StatusEntry[]> {
  const w = await readWip(repo, root);
  const rows: StatusEntry[] = [];
  for (const path of new Set([...w.head.keys(), ...w.stage0.keys()])) {
    if (w.unmerged.has(path)) continue;
    const h = w.head.get(path) ?? null;
    const i = w.stage0.get(path) ?? null;
    const index = i?.intentToAdd ? '.' : same(h, i) ? '.' : letter(h, i);
    const worktree = !i ? '.' : i.intentToAdd ? 'A' : await worktreeLetter(repo, w, i);
    if (index !== '.' || worktree !== '.') rows.push({ path, origPath: null, index, worktree, kind: 'ordinary' });
  }
  await pairStagedRenames(repo, w, rows);
  for (const [path, stages] of w.unmerged) {
    const xy = UNMERGED[[1, 2, 3].filter((s) => stages.some((e) => e.stage === s)).join('')] ?? 'UU';
    rows.push({ path, origPath: null, index: xy[0], worktree: xy[1], kind: 'unmerged' });
  }
  rows.sort((a, b) => compareBytewise(a.path, b.path));
  const tracked = new Set([...w.stage0.keys(), ...w.unmerged.keys()]);
  const gitlinks = new Set([...w.stage0.values()].filter((e) => e.mode === MODE_GITLINK).map((e) => e.path));
  for (const path of await untrackedFiles(repo, w.path, tracked, gitlinks)) rows.push({ path, origPath: null, index: '?', worktree: '?', kind: 'untracked' });
  return rows;
}

/** git's rename pass over the index side: a staged deletion and a staged addition that pair become one `R` row at the new path. */
async function pairStagedRenames(repo: ReadRepo, w: Wip, rows: StatusEntry[]): Promise<void> {
  const del = rows.filter((r) => r.index === 'D');
  const add = rows.filter((r) => r.index === 'A');
  if (del.length === 0 || add.length === 0) return;
  const file = (path: string, e: FileEntry): RenameFile => ({ path, oid: e.oid, mode: e.mode, load: () => readBlobBytes(repo, e.oid) });
  const pairs = await pairRenames(
    del.map((r) => file(r.path, w.head.get(r.path)!)),
    add.map((r) => file(r.path, w.stage0.get(r.path)!)),
  );
  for (const p of pairs) {
    const to = rows.find((r) => r.path === p.to.path)!;
    to.kind = 'renamed';
    to.index = 'R';
    to.origPath = p.from.path;
    rows.splice(rows.findIndex((r) => r.path === p.from.path && r.index === 'D'), 1);
  }
}

/** `status::summarize`: the graph's WIP counts. */
export function summarize(entries: StatusEntry[]): WipCounts {
  const c: WipCounts = { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0 };
  for (const e of entries) {
    if (e.kind === 'unmerged') c.conflicted++;
    else if (e.kind === 'untracked') c.added++;
    else if (e.index === 'D' || e.worktree === 'D') c.deleted++;
    else if (e.index === 'A') c.added++;
    else if (e.kind === 'renamed' && e.index === 'R') c.renamed++;
    else c.modified++;
  }
  return c;
}

/** `precheck::dirty`. */
export interface Dirty {
  /** Index or worktree changes (a rename's both paths), conflicted paths included. */
  tracked: Set<string>;
  untracked: Set<string>;
  conflicted: number;
  unmerged: string[];
}

export function dirtyOf(entries: StatusEntry[]): Dirty {
  const d: Dirty = { tracked: new Set(), untracked: new Set(), conflicted: 0, unmerged: [] };
  for (const e of entries) {
    if (e.kind === 'untracked') {
      d.untracked.add(e.path);
      continue;
    }
    if (e.kind === 'unmerged') {
      d.conflicted++;
      d.unmerged.push(e.path);
    }
    if (e.origPath) d.tracked.add(e.origPath);
    d.tracked.add(e.path);
  }
  return d;
}

export async function dirty(repo: ReadRepo, root: string): Promise<Dirty> {
  return dirtyOf(await statusEntries(repo, root));
}
