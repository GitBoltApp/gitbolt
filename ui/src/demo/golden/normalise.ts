// What both sides of a parity comparison go through: a JSON round trip (undefined fields gone, as
// serde leaves them out), large base64 and hex dumps as their digest (the harness's
// `golden::digest_large_strings`), and the git-lfs version masked (the harness's machine may not
// have git-lfs).
const LARGE = 16 * 1024;

async function digest(s: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}:${s.length}`;
}

async function digestLarge(v: unknown): Promise<unknown> {
  if (Array.isArray(v)) return Promise.all(v.map(digestLarge));
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = (k === 'base64' || k === 'dump') && typeof x === 'string' && x.length > LARGE ? await digest(x) : await digestLarge(x);
  return out;
}

export async function normaliseResponse(method: string, value: unknown): Promise<unknown> {
  const v = await digestLarge(JSON.parse(JSON.stringify(value ?? null)));
  if (method === 'lfsStatus' && v !== null && typeof v === 'object') return { ...(v as object), version: '<git-lfs>' };
  return v;
}
