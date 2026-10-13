// Opening repositories, their info, the settings and profile, watching, and the boot's plumbing.
import type { AppInfoPayload } from '../../api/gen/AppInfoPayload';
import type { RemotePayload } from '../../api/gen/RemotePayload';
import type { RepoInfoPayload } from '../../api/gen/RepoInfoPayload';
import { gbError } from '../engine/errors';
import { normalisePath } from '../engine/memfs';
import { compareBytes } from '../engine/refs';
import { hostKind, parseRemoteUrl, redact } from '../engine/remotes';
import type { DemoRepo } from '../engine/repo';
import type { HandlerTable } from '../transport';

const APP_INFO: AppInfoPayload = {
  appVersion: (import.meta.env.VITE_GITBOLT_VERSION as string | undefined) ?? '0.0.0',
  build: null,
  gitVersion: 'in-browser (isomorphic-git)',
  installKind: 'none',
  home: null,
};

/** The remotes, origin first then by name (details::remotes). */
export async function remotePayloads(repo: DemoRepo): Promise<RemotePayload[]> {
  const out = (await repo.remotes()).map(({ name, url }): RemotePayload => {
    const p = url === null ? null : parseRemoteUrl(url);
    return { name, host: p?.host ?? null, path: p?.path ?? null, hostKind: p ? hostKind(p.host) : 'generic' };
  });
  return out.sort((a, b) => Number(a.name !== 'origin') - Number(b.name !== 'origin') || compareBytes(a.name, b.name));
}

/** shelldata::repo_info. The handle is always the main worktree's, so `mainWorktree` is null. */
export async function repoInfo(repo: DemoRepo): Promise<RepoInfoPayload> {
  const urls = new Map((await repo.remotes()).map((r) => [r.name, r.url]));
  const remotes = (await remotePayloads(repo)).map((r) => ({ name: r.name, url: redact(urls.get(r.name) ?? ''), host: r.host, path: r.path, hostKind: r.hostKind }));
  return { remotes, mainWorktree: null, commonDir: repo.gitdir, submodules: {} };
}

const shorten = (ref: string | null) => (ref === null ? null : ref.replace(/^refs\/(heads|tags|remotes)\//, ''));

export const repoHandlers = {
  openRepo: async ({ path }, ctx) => {
    const { repo, worktree } = await ctx.repos.open(path);
    return { id: repo.id, path: repo.path, name: repo.name, worktree };
  },
  peekRepo: async ({ path }, ctx) => {
    const { repo, worktree } = await ctx.repos.locate(path);
    const w = (await repo.worktrees()).find((x) => x.path === worktree);
    if (!w || !path.startsWith('/') || normalisePath(path) !== worktree) throw gbError('NotFound', `not a repository: ${path}`);
    return { remotes: await remotePayloads(repo), branch: shorten(w.branch) };
  },
  repoInfo: async ({ repo }, ctx) => repoInfo(ctx.repos.get(repo)),
  loadState: async (_params, ctx) => ({ settings: ctx.state.settings, profile: ctx.state.profile, profiles: ctx.state.profiles }),
  saveSettings: async ({ settings }, ctx) => {
    ctx.state.settings = settings;
    return null;
  },
  saveProfile: async ({ profile }, ctx) => {
    ctx.state.profile = profile;
    ctx.state.profiles = ctx.state.profiles.map((p) => (p.id === profile.id ? { id: p.id, name: profile.name, color: profile.color } : p));
    return null;
  },
  watchRepo: async ({ repo }, ctx) => {
    ctx.repos.get(repo);
    ctx.state.watched.add(repo);
    return null;
  },
  unwatchRepo: async ({ repo }, ctx) => {
    ctx.state.watched.delete(repo);
    return null;
  },
  unwatchAll: async (_params, ctx) => {
    ctx.state.watched.clear();
    return null;
  },
  appInfo: async () => APP_INFO,
  // No launch path and no forwarded opens: the demo's tabs come from its profile.
  launchRepo: async () => null,
  takeOpenRequests: async () => [],
  // There's no log file to write to.
  logFrontend: async () => null,
  setDebugLogging: async () => null,
} satisfies Partial<HandlerTable>;
