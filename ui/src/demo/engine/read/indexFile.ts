import { compareBytewise, utf8Bytes } from './bytes';
import { MODE_EXEC, MODE_FILE, MODE_LINK } from './trees';
import { fail, lstatOrNull, readBytesOrNull, type ReadRepo, type ReadStat } from './seam';

/** The stat data an index entry recorded for its worktree file (times as whole seconds and nanoseconds).
 *  A written entry carries all of it: isomorphic-git's own stat check also compares ctime, uid and gid. */
export interface IndexStat {
  mtimeS: number;
  mtimeNs: number;
  ino: number;
  size: number;
  ctimeS?: number;
  ctimeNs?: number;
  dev?: number;
  uid?: number;
  gid?: number;
}

export interface IndexEntry {
  path: string;
  mode: number;
  oid: string;
  /** 0, or 1–3 for a conflict's base, ours and theirs. */
  stage: number;
  /** Set when read from an index file. */
  stat?: IndexStat;
  /** `git add -N`: in the index (with the empty blob), but left out of the trees `write-tree` makes. */
  intentToAdd?: boolean;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** git's index, versions 2 and 3 (extensions are skipped). */
export function parseIndex(bytes: Uint8Array): IndexEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'DIRC') fail('Other', 'not a git index');
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) fail('Other', `index version ${version} isn't supported in the demo`);
  const count = view.getUint32(8);
  const decoder = new TextDecoder();
  const out: IndexEntry[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    const start = at;
    const stat: IndexStat = {
      ctimeS: view.getUint32(at), ctimeNs: view.getUint32(at + 4), mtimeS: view.getUint32(at + 8), mtimeNs: view.getUint32(at + 12),
      dev: view.getUint32(at + 16), ino: view.getUint32(at + 20), uid: view.getUint32(at + 28), gid: view.getUint32(at + 32), size: view.getUint32(at + 36),
    };
    const mode = view.getUint32(at + 24);
    const oid = hex(bytes.subarray(at + 40, at + 60));
    const flags = view.getUint16(at + 60);
    at += 62;
    // Version 3's extended flags: intent-to-add is kept (skip-worktree is never set in the demo).
    let intentToAdd = false;
    if (version === 3 && flags & 0x4000) {
      intentToAdd = (view.getUint16(at) & 0x2000) !== 0;
      at += 2;
    }
    const end = bytes.indexOf(0, at);
    if (end < 0) fail('Other', 'truncated git index');
    const path = decoder.decode(bytes.subarray(at, end));
    at = start + ((end - start + 8) & ~7);
    out.push({ path, mode, oid, stage: (flags >> 12) & 3, stat, ...(intentToAdd ? { intentToAdd: true } : {}) });
  }
  return out;
}

/** An index of `entries` (sorted by path, then stage), each with its stat data (zero without):
 *  version 2, or 3 when an entry is intent-to-add. */
export async function serializeIndex(entries: IndexEntry[]): Promise<Uint8Array> {
  const sorted = [...entries].sort((a, b) => compareBytewise(a.path, b.path) || a.stage - b.stage);
  const version = sorted.some((e) => e.intentToAdd) ? 3 : 2;
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header.set(utf8Bytes('DIRC'));
  new DataView(header.buffer).setUint32(4, version);
  new DataView(header.buffer).setUint32(8, sorted.length);
  parts.push(header);
  for (const e of sorted) {
    const path = utf8Bytes(e.path);
    const extended = e.intentToAdd === true;
    const nameAt = extended ? 64 : 62;
    const entry = new Uint8Array((nameAt + path.length + 8) & ~7);
    const v = new DataView(entry.buffer);
    const s = e.stat;
    if (s) {
      v.setUint32(0, s.ctimeS ?? 0);
      v.setUint32(4, s.ctimeNs ?? 0);
      v.setUint32(8, s.mtimeS);
      v.setUint32(12, s.mtimeNs);
      v.setUint32(16, s.dev ?? 0);
      v.setUint32(20, s.ino);
      v.setUint32(28, s.uid ?? 0);
      v.setUint32(32, s.gid ?? 0);
      v.setUint32(36, s.size);
    }
    v.setUint32(24, e.mode);
    for (let i = 0; i < 20; i++) entry[40 + i] = parseInt(e.oid.slice(i * 2, i * 2 + 2), 16);
    v.setUint16(60, (extended ? 0x4000 : 0) | (e.stage << 12) | Math.min(path.length, 0xfff));
    if (extended) v.setUint16(62, 0x2000);
    entry.set(path, nameAt);
    parts.push(entry);
  }
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  const sha = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
  const out = new Uint8Array(body.length + 20);
  out.set(body);
  out.set(sha, body.length);
  return out;
}

export async function readIndex(repo: ReadRepo, worktreeGitdir: string): Promise<IndexEntry[]> {
  const bytes = await readBytesOrNull(repo, `${worktreeGitdir}/index`);
  return bytes ? parseIndex(bytes) : [];
}

export const U32 = 2 ** 32;

/** A time in milliseconds as the index stores it: whole seconds and the rest as nanoseconds, each mod
 *  2^32 (isomorphic-git's normalizeStats, and gitindex.ts's refresh). */
export function stamp(ms: number): [number, number] {
  const s = Math.floor(ms / 1000);
  return [s % U32, Math.floor((ms - s * 1000) * 1e6) % U32];
}

/** When the index at `worktreeGitdir` was last written (ms), or null without one. Read it before the
 *  entries: an older time only makes more of them racy. */
export async function indexMtime(repo: ReadRepo, worktreeGitdir: string): Promise<number | null> {
  return (await lstatOrNull(repo, `${worktreeGitdir}/index`))?.mtimeMs ?? null;
}

/** git's stat check (`ie_match_stat`): the file's lstat still has the mode, size, inode and mtime its
 *  entry recorded, so it still holds the entry's blob without being read. An entry whose mtime isn't
 *  older than the index itself is racily clean (the file may have changed within that tick) and
 *  never passes, as git then compares the content. */
export function statMatches(e: IndexEntry, st: ReadStat, indexMtimeMs: number | null): boolean {
  if (!e.stat || indexMtimeMs === null || st.mtimeMs === undefined || st.ino === undefined) return false;
  const mode = st.isSymbolicLink() ? MODE_LINK : st.isFile() ? (st.mode & 0o111 ? MODE_EXEC : MODE_FILE) : null;
  if (mode !== e.mode || st.size % U32 !== e.stat.size || st.ino % U32 !== e.stat.ino) return false;
  const [s, ns] = stamp(st.mtimeMs);
  if (s !== e.stat.mtimeS || ns !== e.stat.mtimeNs) return false;
  const [is, ins] = stamp(indexMtimeMs);
  return is > s || (is === s && ins > ns);
}
