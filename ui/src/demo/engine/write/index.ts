// A worktree's index for writes: 1b's parser (full stat data and intent-to-add kept), written back
// sorted with every entry's stat data, so the next status trusts the files a write didn't touch
// (1b's `statMatches`, and isomorphic-git's own check).
import * as git from 'isomorphic-git';
import { compareBytewise } from '../read/bytes';
import { readIndex, serializeIndex, type IndexEntry, type IndexStat, stamp, U32 } from '../read/indexFile';
import { igNoCache } from '../read/seam';
import { worktreeFile } from '../read/worktree';
import type { WriteWt } from './seam';

export type { IndexEntry };

export const sortIndex = (entries: IndexEntry[]): IndexEntry[] => [...entries].sort((a, b) => compareBytewise(a.path, b.path) || a.stage - b.stage);

export async function loadIndex(wt: WriteWt): Promise<IndexEntry[]> {
  return readIndex(wt.repo, wt.gitdir);
}

export async function saveIndex(wt: WriteWt, entries: IndexEntry[]): Promise<void> {
  wt.fs.writeFileSync(`${wt.gitdir}/index`, await serializeIndex(sortIndex(entries)));
}

/** The index's stat data for whatever is at `path` now; null when nothing is there. */
export function statOf(wt: WriteWt, path: string): IndexStat | null {
  let st;
  try {
    st = wt.fs.lstatSync(`${wt.root}/${path}`);
  } catch {
    return null;
  }
  const [mtimeS, mtimeNs] = stamp(st.mtimeMs);
  const [ctimeS, ctimeNs] = stamp(st.ctimeMs);
  return { mtimeS, mtimeNs, ctimeS, ctimeNs, dev: st.dev % U32, ino: st.ino % U32, uid: st.uid % U32, gid: st.gid % U32, size: st.size % U32 };
}

/** `git add` of one path: its bytes written as a blob, its entry (the file's mode, its stat data).
 *  Null when no file or link is there (a folder, or nothing). */
export async function entryOfFile(wt: WriteWt, path: string): Promise<IndexEntry | null> {
  const f = await worktreeFile(wt.repo, wt.root, path);
  if (!f) return null;
  const oid = await git.writeBlob({ ...igNoCache(wt.repo), blob: f.bytes });
  const stat = statOf(wt, path);
  return { path, mode: f.mode, oid, stage: 0, ...(stat ? { stat } : {}) };
}

/** `entries` with every stage of `path` replaced by `entry`, or removed when it's null. */
export function withEntry(entries: IndexEntry[], path: string, entry: IndexEntry | null): IndexEntry[] {
  const out = entries.filter((e) => e.path !== path);
  if (entry) out.push(entry);
  return out;
}

export function stage0Of(entries: IndexEntry[]): Map<string, IndexEntry> {
  return new Map(entries.filter((e) => e.stage === 0).map((e) => [e.path, e]));
}

/** The conflicted paths and their stages (1–3). */
export function unmergedOf(entries: IndexEntry[]): Map<string, IndexEntry[]> {
  const out = new Map<string, IndexEntry[]>();
  for (const e of entries) if (e.stage !== 0) out.set(e.path, [...(out.get(e.path) ?? []), e]);
  return out;
}

/** `next`, with the stat data of the current stage-0 entry when that one names the same blob and mode
 *  (git's two-way read-tree and `reset` keep it): the file isn't read again. */
export function keepStat(current: Map<string, IndexEntry>, next: IndexEntry): IndexEntry {
  const now = current.get(next.path);
  if (!now?.stat || now.oid !== next.oid || now.mode !== next.mode) {
    const { stat: _drop, ...rest } = next;
    void _drop;
    return rest;
  }
  return { ...next, stat: now.stat };
}
