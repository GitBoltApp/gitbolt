import * as git from 'isomorphic-git';
import { latin1 } from '../objects';

export { decodeText, latin1, lossyUtf8 } from '../objects';
export { asciiLower } from '../remotes';
export { compareBytes as compareBytewise } from '../refs';

/** Git's binary heuristic (xdiff's `buffer_is_binary`): a NUL in the first 8000 bytes. */
export const BINARY_SNIFF_BYTES = 8000;
/** Above this size (either side), the diff viewer asks before loading (the core's `LARGE_FILE_BYTES`). */
export const LARGE_FILE_BYTES = 2 * 1024 * 1024;
/** The hard ceiling per side, even after "Load anyway" (`MAX_FORCED_BYTES`). */
export const MAX_FORCED_BYTES = 64 * 1024 * 1024;

export function base64(bytes: Uint8Array): string {
  return btoa(latin1(bytes));
}

const encoder = new TextEncoder();
export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The bytes as UTF-8 text, or null when they aren't valid UTF-8 (a BOM is kept as a char). */
export function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The blob id of these bytes, as `git hash-object` gives it with no filters (the core's `worktree_id`). */
export async function blobId(bytes: Uint8Array): Promise<string> {
  return (await git.hashBlob({ object: bytes })).oid;
}

export function isBinaryHead(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}
