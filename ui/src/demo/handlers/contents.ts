import type { BlobPayload } from '../../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../../api/gen/DiffContentsPayload';
import type { HexSide } from '../../api/gen/HexSide';
import type { LfsSide } from '../../api/gen/LfsSide';
import type { HandlerTable } from '../transport';
import { base64, BINARY_SNIFF_BYTES, blobId, LARGE_FILE_BYTES, latin1, MAX_FORCED_BYTES } from '../engine/read/bytes';
import { decodeBlob, eolOnlyChange, hexLines, isBinaryDeclared } from '../engine/read/decode';
import { readRepoOf, type ReadRepo } from '../engine/read/seam';
import { bytesOf, lfsSideOf, resolve, resolveSource, sizeOf, type Resolved, type Side } from '../engine/read/sides';

export const HEX_CAP = 256 * 1024;

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'];
const MEDIA = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'weba', 'webm', 'ogv', 'mp4', 'm4v', 'mov', 'ttf', 'otf', 'woff', 'woff2'];
const extOf = (path: string) => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : null);
const isImagePath = (p: string) => IMAGE.includes(extOf(p) ?? '');
const isMediaPath = (p: string) => MEDIA.includes(extOf(p) ?? '');
const isPdfPath = (p: string) => extOf(p) === 'pdf';
const isPdfBytes = (b: Uint8Array) => latin1(b.subarray(0, 1024)).includes('%PDF-');

type Loaded = { bytes: Uint8Array; declared: string | null };

async function diffContents(repo: ReadRepo, path: string, oldPath: string | undefined, oldSide: Side, newSide: Side, force: boolean): Promise<DiffContentsPayload> {
  const image = isImagePath(path) || (extOf(path) === 'svg' && oldPath !== undefined && isImagePath(oldPath));
  const media = isMediaPath(path);
  const pdf = isPdfPath(path);
  const oldR = await resolve(repo, path, oldSide);
  const newR = await resolve(repo, path, newSide);
  const oldSize = oldR ? await sizeOf(repo, oldR) : null;
  const newSize = newR ? await sizeOf(repo, newR) : null;
  const limit = force ? MAX_FORCED_BYTES : LARGE_FILE_BYTES;
  let tooLarge = [oldSize, newSize].some((s) => s !== null && s > limit);
  // undefined: not read (no side, or already too large); null: past the limit when read.
  const read = async (r: Resolved | null): Promise<Loaded | null | undefined> => (r && !tooLarge ? bytesOf(repo, r, limit) : undefined);
  const oldBytes = await read(oldR);
  const newBytes = await read(newR);
  tooLarge ||= oldBytes === null || newBytes === null;
  const textSide = [oldBytes, newBytes].some((b) => b && !isBinaryDeclared(b.bytes, b.declared));
  const mediaBytes = media && !textSide;
  const load = async (bytes: Loaded | null | undefined, size: number | null, side: Side, lfs: LfsSide | null): Promise<BlobPayload | null> => {
    if (size === null) return null;
    const extra = { ...(lfs && side.kind === 'worktree' ? { filtered: true } : {}), ...(lfs ? { lfs } : {}) };
    if (lfs && !lfs.downloaded) {
      return { size: lfs.size, binary: false, encoding: '', eol: 'none', text: null, base64: null, hash: bytes ? await blobId(bytes.bytes) : null, ...extra };
    }
    if (!bytes || tooLarge) {
      return { size: bytes === null ? Math.max(size, limit + 1) : size, binary: false, encoding: '', eol: 'none', text: null, base64: null, hash: null, ...extra };
    }
    const d = decodeBlob(bytes.bytes, bytes.declared);
    const withBytes = (d.binary && (image || mediaBytes)) || (pdf && isPdfBytes(bytes.bytes));
    return { size, binary: d.binary, encoding: d.encoding, eol: d.eol, text: d.text, base64: withBytes ? base64(bytes.bytes) : null, hash: await blobId(bytes.bytes), ...extra };
  };
  const oldLfs = oldR ? lfsSideOf(oldR) : null;
  const newLfs = newR ? lfsSideOf(newR) : null;
  const old = await load(oldBytes, oldSize, oldSide, oldLfs);
  const neu = await load(newBytes, newSize, newSide, newLfs);
  const eolOnly = old?.text != null && neu?.text != null && eolOnlyChange(old.text, neu.text);
  const lfs = oldLfs !== null || newLfs !== null || [oldSide, newSide].some((s) => s.kind === 'worktree' && s.lfs);
  const out: DiffContentsPayload = { old, new: neu, tooLarge, eolOnly, image, ...(pdf ? { pdf: true } : {}), ...(lfs ? { lfs: true } : {}), ...(media ? { media: true } : {}) };
  await ungateBinary(repo, [oldSide, newSide], [oldR, newR], out);
  return out;
}

/** `ungate_binary`: a held-back binary side shows as a capped hex dump instead, whatever its size. */
async function ungateBinary(repo: ReadRepo, sides: Side[], resolved: (Resolved | null)[], c: DiffContentsPayload): Promise<void> {
  const playable = c.media === true && [c.old, c.new].every((s) => !s || s.size <= MAX_FORCED_BYTES);
  if (!c.tooLarge || c.image || c.pdf || playable) return;
  let binary = false;
  for (const [i, payload] of [c.old, c.new].entries()) {
    const r = resolved[i];
    if (!payload || !r) continue;
    const head = await bytesOf(repo, r, Number.MAX_SAFE_INTEGER);
    const declared = sides[i].kind === 'worktree' ? (sides[i] as { encoding: string | null }).encoding : null;
    if (head && isBinaryDeclared(head.bytes.subarray(0, BINARY_SNIFF_BYTES), declared)) {
      payload.binary = true;
      binary = true;
    }
  }
  if (binary) c.tooLarge = false;
}

async function hexSide(repo: ReadRepo, path: string, side: Side): Promise<HexSide | null> {
  const r = await resolve(repo, path, side);
  if (!r) return null;
  const size = await sizeOf(repo, r);
  const all = (await bytesOf(repo, r, Number.MAX_SAFE_INTEGER))!.bytes;
  const bytes = all.subarray(0, HEX_CAP);
  return { size: bytes.length < HEX_CAP ? bytes.length : Math.max(size, HEX_CAP), shown: bytes.length, dump: hexLines(bytes) };
}

export const contentsHandlers: Pick<HandlerTable, 'diffContents' | 'hexDump'> = {
  diffContents: async ({ repo: id, path, old, new: neu, force, oldPath }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const oldSide = await resolveSource(repo, path, old);
    const newSide = await resolveSource(repo, path, neu);
    return diffContents(repo, path, oldPath, oldSide, newSide, force);
  },
  hexDump: async ({ repo: id, path, old, new: neu }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const oldSide = await resolveSource(repo, path, old);
    const newSide = await resolveSource(repo, path, neu);
    return { old: await hexSide(repo, path, oldSide), new: await hexSide(repo, path, newSide), cap: HEX_CAP };
  },
};
