// The demo's network (plan 4): a remote's URL reaches an in-memory git dir or nothing. A local
// path that is a git dir; the fake forge's project URL (https or ssh, `gitlab.example.com`) for a
// bundle whose forge.json names that project; anything else is "Not in the demo", kind `Other` as
// the core's failed fetch of a host it can't resolve. No request ever leaves the page.
import type { DemoContext } from '../../context';
import { notInDemo } from '../errors';
import type { MemFs } from '../memfs';
import { demoRoot } from '../paths';
import { parseRemoteUrl, redact } from '../remotes';

export const FORGE_HOST = 'gitlab.example.com';

export interface DemoNetwork {
  /** Simulated transfer time (0 in tests). */
  latencyMs: number;
  /** Timers (the teammate); tests replace it. */
  schedule(ms: number, f: () => void): void;
  /** Called before any fetch, pull or push reaches `gitdir` (the teammate's trigger, Task 17). */
  beforeNetwork: ((fs: MemFs, gitdir: string) => Promise<void>)[];
  /** Extra refs an origin serves that aren't files (the forge's MR heads, Task 21): name → oid. */
  virtualRefs: ((fs: MemFs, gitdir: string) => Promise<Map<string, string>>)[];
  /** Called after a push moved `gitdir`'s refs (the forge's MR heads and pipelines, Task 24). */
  afterPush: ((fs: MemFs, gitdir: string, moved: { ref: string; old: string | null; new: string | null }[]) => Promise<void>)[];
  /** What the origin's server says after a push of `branch` (`created`: a new branch): `remote:` lines (the forge's GitLab links, Task 25's `installForgeHooks`). */
  serverLines: ((fs: MemFs, gitdir: string, branch: string, created: boolean) => Promise<string[]>)[];
  /** The runtime's file system (the forge reads its files before any repository is open). */
  fs: MemFs | null;
  /** Each loaded bundle's forge project (lowercase; null: no forge.json), read once. */
  projects: Map<string, string | null>;
}

const nets = new WeakMap<DemoContext, DemoNetwork>();

export function netOf(ctx: DemoContext): DemoNetwork {
  let n = nets.get(ctx);
  if (!n) nets.set(ctx, (n = { latencyMs: 300, schedule: (ms, f) => void setTimeout(f, ms), beforeNetwork: [], virtualRefs: [], afterPush: [], serverLines: [], fs: null, projects: new Map() }));
  return n;
}

const isGitDir = (fs: MemFs, p: string) => fs.existsSync(`${p}/HEAD`) && fs.existsSync(`${p}/objects`);

/** The origin of the loaded bundle whose forge.json names `project`. */
async function forgeOrigin(ctx: DemoContext, fs: MemFs, project: string): Promise<string | null> {
  const known = netOf(ctx).projects;
  for (const r of ctx.repos.manifest.repos) {
    if (!ctx.repos.loaded(r.name)) continue;
    if (!known.has(r.name)) {
      let path: string | null = null;
      try {
        path = (JSON.parse((await fs.promises.readFile(demoRoot(r.name, 'forge.json'), 'utf8')) as string) as { project?: string }).project?.toLowerCase() ?? null;
      } catch {
        // no forge for this one
      }
      known.set(r.name, path);
    }
    if (known.get(r.name) === project) return demoRoot(r.name, 'origin.git');
  }
  return null;
}

export async function resolveRemote(ctx: DemoContext, fs: MemFs, url: string, verb: 'fetching from' | 'pushing to'): Promise<string> {
  const path = url.startsWith('file://') ? url.slice('file://'.length) : url;
  if (path.startsWith('/')) {
    const bare = path.replace(/\/+$/, '');
    for (const p of [bare, `${bare}/.git`]) if (isGitDir(fs, p)) return p;
    return notInDemo(`${verb} ${redact(path)}`);
  }
  const parsed = parseRemoteUrl(url);
  if (parsed && parsed.host === FORGE_HOST) {
    const origin = await forgeOrigin(ctx, fs, parsed.path.toLowerCase());
    if (origin && isGitDir(fs, origin)) return origin;
  }
  // The host only: a URL's user, password or token never reaches the message.
  return notInDemo(`${verb} ${parsed?.host ?? 'that remote'}`);
}
