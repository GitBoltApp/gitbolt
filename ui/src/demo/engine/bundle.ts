// The reader of `.gbdemo` bundles (written by ui/scripts/pack-demo.mjs; the format is in the
// website demo's interfaces doc): unpacked with DecompressionStream, since GitHub Pages serves
// binary files as they are.

export interface BundleFile { path: string; mode: number; data: Uint8Array }
export interface Bundle { name: string; files: BundleFile[] }
interface Header { version: number; name: string; files: { path: string; size: number; mode: number }[] }

const MAGIC = new TextEncoder().encode('GBDEMO1\n');
const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `bytes` unpacked when they're gzip; as they are when a server already unpacked them (it sent
 * them with Content-Encoding: gzip). */
export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return isGzip(bytes) ? gunzip(bytes) : bytes.slice();
}

export async function readBundle(bytes: Uint8Array): Promise<Bundle> {
  return parseBundle(await gunzipIfNeeded(bytes));
}

/** An unpacked bundle's files. Throws on anything else: a truncated bundle, trailing bytes, a
 * path that would leave its fixture folder, a name that isn't a plain file name. */
export function parseBundle(raw: Uint8Array): Bundle {
  if (raw.length < 12 || MAGIC.some((b, i) => raw[i] !== b)) throw new Error('not a GitVolt demo bundle');
  const n = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(8, true);
  if (12 + n > raw.length) throw new Error('truncated demo bundle (header)');
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(12, 12 + n))) as Header;
  if (header.version !== 1) throw new Error(`unsupported demo bundle version ${String(header.version)}`);
  if (!/^[A-Za-z0-9_.-]+$/.test(header.name) || header.name === '.' || header.name === '..') throw new Error(`bad demo bundle name: ${header.name}`);
  let at = 12 + n;
  const files: BundleFile[] = [];
  for (const f of header.files) {
    if (f.path.startsWith('/') || f.path.split('/').some((p) => p === '' || p === '.' || p === '..')) throw new Error(`bad path in demo bundle: ${f.path}`);
    if (at + f.size > raw.length) throw new Error(`truncated demo bundle (${f.path})`);
    files.push({ path: f.path, mode: f.mode, data: raw.subarray(at, at + f.size) });
    at += f.size;
  }
  if (at !== raw.length) throw new Error('trailing bytes after the demo bundle');
  return { name: header.name, files };
}
