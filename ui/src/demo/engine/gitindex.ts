// A worktree's index (version 2) refreshed in place: the stat half of `git update-index
// --refresh`. Bundles carry indexes with their stat data zeroed (ui/scripts/pack-demo.mjs's
// scrubIndexStat), so without this isomorphic-git would hash every tracked file on each status.
import type { MemFs, MemStats } from './memfs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const U32 = 2 ** 32;

async function sha1(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
}

/** The id git gives `content` as a blob. */
async function blobId(content: Uint8Array): Promise<Uint8Array> {
  const header = encoder.encode(`blob ${content.length}\0`);
  const bytes = new Uint8Array(header.length + content.length);
  bytes.set(header);
  bytes.set(content, header.length);
  return sha1(bytes);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The file's content as the entry's `mode` would store it, or null when it's no longer that
 * kind of file (a regular file's exec bit, as git's `core.filemode` sees it, counts). */
function contentAs(fs: MemFs, path: string, st: MemStats, mode: number): Uint8Array | null {
  const type = mode >>> 12;
  if (type === 0o10 && st.isFile() && (st.mode & 0o111 ? 0o100755 : 0o100644) === mode) return fs.readFileSync(path) as Uint8Array;
  if (type === 0o12 && st.isSymbolicLink()) return encoder.encode(fs.readlinkSync(path));
  return null;
}

/** Writes `workdir`'s current stat data into each stage-0 entry of the index at `indexPath` whose
 * file still hashes to the entry's blob, and redoes the checksum. Ids, modes, flags, conflict
 * stages and extensions stay as they are; a modified file keeps its old stat data, so status
 * still hashes it. An index that isn't a well-formed version 2 is left alone. Returns how many
 * entries it refreshed. Needs WebCrypto's SHA-1 (a secure context, or Node). */
export async function refreshIndexStat(fs: MemFs, workdir: string, indexPath: string): Promise<number> {
  let buf: Uint8Array<ArrayBuffer>;
  try {
    buf = new Uint8Array(fs.readFileSync(indexPath) as Uint8Array);
  } catch {
    return 0;
  }
  const view = new DataView(buf.buffer);
  if (buf.length < 32 || decoder.decode(buf.subarray(0, 4)) !== 'DIRC' || view.getUint32(4) !== 2) return 0;
  const end = buf.length - 20;
  const count = view.getUint32(8);
  let refreshed = 0;
  for (let i = 0, o = 12; i < count; i++) {
    const at = o;
    const nul = at + 62 <= end ? buf.indexOf(0, at + 62) : -1;
    if (nul < 0 || nul >= end) return 0;
    // 62 bytes of fields, the name, then 1 to 8 NULs to a multiple of 8.
    o += Math.ceil((nul - at + 1) / 8) * 8;
    if ((view.getUint16(at + 60) >> 12) & 3) continue;
    const path = `${workdir}/${decoder.decode(buf.subarray(at + 62, nul))}`;
    let st: MemStats;
    try {
      st = fs.lstatSync(path);
    } catch {
      continue;
    }
    const content = contentAs(fs, path, st, view.getUint32(at + 24));
    if (content === null || !sameBytes(await blobId(content), buf.subarray(at + 40, at + 60))) continue;
    // isomorphic-git's normalizeStats: whole seconds and the rest as nanoseconds, each mod 2^32.
    const time = (field: number, ms: number) => {
      const s = Math.floor(ms / 1000);
      view.setUint32(field, s % U32);
      view.setUint32(field + 4, Math.floor((ms - s * 1000) * 1e6) % U32);
    };
    time(at, st.ctimeMs);
    time(at + 8, st.mtimeMs);
    view.setUint32(at + 16, st.dev % U32);
    view.setUint32(at + 20, st.ino % U32);
    view.setUint32(at + 28, st.uid % U32);
    view.setUint32(at + 32, st.gid % U32);
    view.setUint32(at + 36, st.size % U32);
    refreshed++;
  }
  if (refreshed > 0) {
    buf.set(await sha1(buf.slice(0, end)), end);
    fs.writeFileSync(indexPath, buf);
  }
  return refreshed;
}
