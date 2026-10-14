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

// HTTP timing and the harness's token file have no counterpart in the page (plan 4's forge
// decision): where a forge answer holds them, by method (dot-separated paths, `[]` for each item of
// a list). The recorder masks the same fields as `<untimed>` (golden.rs `UNTIMED_FIELDS`: keep the
// two tables alike); the demo's are masked the same here, so a field either side leaves out fails.
export const UNTIMED: Record<string, string[]> = {
  forgeAccounts: ['[].account.addedAt', '[].account.storage', '[].account.versionCheckedAt'],
  forgeBranchMrs: ['fetchedAt', 'pollIntervalSecs'],
  forgeCachedMrs: ['savedAt', 'badges.fetchedAt', 'badges.pollIntervalSecs', 'list.fetchedAt', 'list.pollIntervalSecs'],
  forgeMrDetail: ['fetchedAt', 'notModified', 'pollIntervalSecs'],
  forgeMrDiscussions: ['fetchedAt', 'notModified', 'pollIntervalSecs'],
  forgeMrList: ['fetchedAt', 'pollIntervalSecs', 'rateLimit'],
};

function maskAt(v: unknown, path: string[]): void {
  const [key, ...rest] = path;
  if (key === '[]') {
    if (Array.isArray(v)) for (const x of v) maskAt(x, rest);
  } else if (key !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (rest.length > 0) maskAt(o[key], rest);
    else if (key in o) o[key] = '<untimed>';
  }
}

/** `v` (a fresh copy) with the method's untimed fields, where present, as `<untimed>`. */
function untimed(method: string, v: unknown): unknown {
  for (const p of UNTIMED[method] ?? []) maskAt(v, p.split('.'));
  return v;
}

/** The transfers whose answer carries an outcome with its op id. */
const TRANSFERS = new Set(['push', 'pull', 'pushTags']);

export async function normaliseResponse(method: string, value: unknown, fixture?: string): Promise<unknown> {
  let v = untimed(method, await digestLarge(JSON.parse(JSON.stringify(value ?? null))));
  // Op ids are each side's own counter (the events are renumbered; answers aren't).
  if (method === 'fetch' && v !== null && typeof v === 'object' && 'op' in v) v = { ...v, op: '<op>' };
  const outcome = TRANSFERS.has(method) && v !== null && typeof v === 'object' ? (v as { outcome?: unknown }).outcome : null;
  if (outcome !== null && typeof outcome === 'object') {
    const o: Record<string, unknown> = { ...outcome };
    if ('op' in o) o.op = '<op>';
    // The sync fixture's origin has a post-receive hook: a push runs it in the core, never in the demo.
    if (fixture === 'sync' && method === 'push' && 'server' in o) o.server = '<server>';
    v = { ...(v as object), outcome: o };
  }
  if (v !== null && typeof v === 'object' && 'journal' in v && 'staging' in v && 'wip' in v) {
    // The demo's digest isn't Rust's `DefaultHasher`: the versions aren't the demo's to match.
    const w = v as { wip: { version?: string; staged?: { version?: string }; unstaged?: { version?: string } } | null };
    if (w.wip) {
      w.wip.version = '<version>';
      if (w.wip.staged) w.wip.staged.version = '<version>';
      if (w.wip.unstaged) w.wip.unstaged.version = '<version>';
    }
  }
  if (method === 'lfsStatus' && v !== null && typeof v === 'object') return { ...(v as object), version: '<git-lfs>' };
  return v;
}

/** A fetch from a host neither side can reach: the core's git is refused the transport
 * (GIT_ALLOW_PROTOCOL=file while recording), the demo says it's not in the demo. */
export function unreachable(fixture: string, request: { method: string; params?: unknown }): boolean {
  return fixture === 'sync' && request.method === 'fetch' && (request.params as { remote?: string } | undefined)?.remote === 'alice';
}

/** Each side's own refusal of that fetch: the core's an `Other` (git's), the demo's an `Other` saying
 *  it's not in the demo. */
export const refusedBy: Record<'core' | 'demo', (e: { kind?: unknown; message?: unknown }) => boolean> = {
  core: (e) => e.kind === 'Other',
  demo: (e) => e.kind === 'Other' && typeof e.message === 'string' && e.message.startsWith('Not in the demo'),
};

/** That fetch's events: its failure's message, when it's `side`'s own refusal. */
export function unreachableEvents(events: unknown[], side: 'core' | 'demo'): unknown[] {
  return events.map((e) => {
    const f = e as { type?: string; outcome?: string; message?: unknown };
    return f.type === 'opFinished' && f.outcome === 'failed' && refusedBy[side]({ kind: 'Other', message: f.message }) ? { ...(e as object), message: '<unreachable>' } : e;
  });
}

/** A GbError as both sides can match it: git's stderr and the core's command id aren't the demo's. */
export function normaliseError(e: unknown): unknown {
  if (e === null || typeof e !== 'object') return e;
  const { kind, message, detail } = e as { kind?: unknown; message?: unknown; detail?: unknown };
  return detail === undefined || detail === null ? { kind, message } : { kind, message, detail };
}

const UNRECORDED = new Set(['opOutput', 'opRemote', 'opProgress']);

/** One scenario's event normaliser: op, queue item and prompt ids renumbered by first appearance (every event's `op`, opStashStep's and authWaiting's included), versions masked. */
export function makeEventNormaliser(): (events: unknown[]) => unknown[] {
  const ops = new Map<number, number>();
  const items = new Map<number, number>();
  const op = (n: number) => ops.get(n) ?? (ops.set(n, ops.size + 1), ops.size);
  const item = (n: number) => items.get(n) ?? (items.set(n, items.size + 1), items.size);
  const prompts = new Map<number, number>();
  const prompt = (n: number) => prompts.get(n) ?? (prompts.set(n, prompts.size + 1), prompts.size);
  const queued = (q: { id: number; op: number } | null) => q && { ...q, id: item(q.id), op: op(q.op) };
  return (events) =>
    (JSON.parse(JSON.stringify(events)) as Record<string, unknown>[])
      .filter((e) => !UNRECORDED.has(e.type as string))
      .map((e) => {
        const out: Record<string, unknown> = { ...e };
        if (typeof e.op === 'number') out.op = op(e.op);
        if (typeof e.prompt === 'number') out.prompt = prompt(e.prompt);
        if (e.type === 'queueChanged') {
          out.running = queued(e.running as { id: number; op: number } | null);
          out.queued = (e.queued as { id: number; op: number }[]).map((q) => queued(q));
        }
        if (e.type === 'repoChanged') out.versions = Object.fromEntries(Object.keys(e.versions as object).map((k) => [k, '<version>']));
        return out;
      });
}
