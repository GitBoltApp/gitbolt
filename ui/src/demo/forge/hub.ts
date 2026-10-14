// The demo's forge hub (the core's forge/hub.rs and mrs.rs) over one account: the visitor (`you`)
// on gitlab.example.com, whose fake GitLab holds every loaded bundle's forge.json. The account has
// no token: nothing here could leave the page.
import type { BranchMrs } from '../../api/gen/BranchMrs';
import type { CachedMrs } from '../../api/gen/CachedMrs';
import type { ForgeAccountView } from '../../api/gen/ForgeAccountView';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeProject } from '../../api/gen/ForgeProject';
import type { ForkPage } from '../../api/gen/ForkPage';
import type { Fresh } from '../../api/gen/Fresh';
import type { MrFilter } from '../../api/gen/MrFilter';
import type { MrList } from '../../api/gen/MrList';
import type { RefMr } from '../../api/gen/RefMr';
import type { RemotePayload } from '../../api/gen/RemotePayload';
import type { RemoteProject } from '../../api/gen/RemoteProject';
import type { RepoProjects } from '../../api/gen/RepoProjects';
import type { CreateContext } from '../../api/gen/CreateContext';
import type { FirstCommit } from '../../api/gen/FirstCommit';
import type { DemoContext } from '../context';
import { readCommit } from '../engine/read/commitText';
import { ancestors, refsUnder, revParse } from '../engine/read/revs';
import type { ForkFacts } from '../gen/ForkFacts';
import type { MemFs } from '../engine/memfs';
import { demoRoot } from '../engine/paths';
import { fail, isGbError, type ReadRepo, viewOf } from '../engine/read/seam';
import { compareBytes } from '../engine/refs';
import { asciiLower } from '../engine/remotes';
import type { DemoRepo } from '../engine/repo';
import { pushTarget } from '../engine/sidebar';
import { remotePayloads } from '../handlers/repo';
import { FakeGitLab } from './fakeGitlab';
import { installForgeHooks } from './gitEffects';
import { DemoGitLab, HOST } from './provider';
import { parseForgeFile } from './seed';

/** cache.rs `RefLookup`: a ref's lookup in any state, with the ref's tips when it was asked. */
export interface RefLookup { tips: string[]; mr: ForgeMr | null; at: number }
/** cache.rs `StoredList`. */
export interface StoredList { mrs: ForgeMr[]; fetchedAt: number }
/** cache.rs's one project's remembered state (the page is the demo's session). */
export interface ProjectCache {
  project: ForgeProject | null;
  /** By filter name. */
  lists: Map<MrFilter, StoredList>;
  /** The badges' open list. */
  open: StoredList | null;
  /** The refs the last open list covered. */
  openRefs: Set<string>;
  lookups: Map<string, RefLookup>;
}
export interface DemoForge {
  fake: FakeGitLab;
  provider: DemoGitLab;
  /** Unix seconds. */
  clock: () => number;
  /** A merge or rebase on the forge acts on the in-memory origin (gitEffects.ts); off in the parity suite. */
  gitEffects: boolean;
  /** By project path. */
  cache: Map<string, ProjectCache>;
  /** Bundles whose forge.json was read (or found missing). */
  loaded: Set<string>;
  /** Bundle name → its forge.json's project. */
  projectOf: Map<string, string>;
  /** Reads the forge.json of each bundle loaded since (`forgeOf` does; so do the network hooks). */
  load: (fs: MemFs) => Promise<void>;
}
/** A repository's remotes as the hub gets them (api.rs `forge_remotes_of`): `preferred` is the
 * chosen target remote (`RemotePayload::main`), only when it is one of them. */
export type Remotes = { remotes: RemotePayload[]; preferred: string | null };
export type BadgeRefs = { tips: Map<string, string[]>; stackBase: string | null };

export const NO_TARGET = 'This repository has no remote on a forge account: add one in Settings › Accounts';
/** mrs.rs `BRANCH_LOOKUPS`. */
export const BRANCH_LOOKUPS = 25;
/** cache.rs `LOOKUP_NONE_SECS`, `LOOKUP_DONE_SECS`. */
const LOOKUP_NONE_SECS = 3600;
const LOOKUP_DONE_SECS = 7 * 24 * 3600;

const forges = new WeakMap<DemoContext, DemoForge>();

/** The page's forge: every loaded bundle's forge.json, merged; created on first use (the runtime's
 * boot makes it, so its network hooks are there before any push). */
export async function forgeOf(ctx: DemoContext, fs: MemFs): Promise<DemoForge> {
  let f = forges.get(ctx);
  if (!f) {
    const clock = () => Math.floor(ctx.clock.nowMs() / 1000);
    const fake = new FakeGitLab([], () => new Date(ctx.clock.nowMs()).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    const forge: DemoForge = { fake, provider: new DemoGitLab(fake), clock, gitEffects: true, cache: new Map(), loaded: new Set(), projectOf: new Map(), load: (vfs) => loadBundles(ctx, forge, vfs) };
    forges.set(ctx, (f = forge));
    installForgeHooks(ctx, forge);
  }
  await f.load(fs);
  return f;
}

/** Reads the forge.json of each bundle loaded since the last look. */
async function loadBundles(ctx: DemoContext, f: DemoForge, fs: MemFs): Promise<void> {
  for (const r of ctx.repos.manifest.repos) {
    if (f.loaded.has(r.name) || !ctx.repos.loaded(r.name)) continue;
    let text: string | null = null;
    try {
      text = (await fs.promises.readFile(demoRoot(r.name, 'forge.json'), 'utf8')) as string;
    } catch {
      // no forge for this bundle
    }
    if (text !== null) {
      const file = parseForgeFile(text);
      f.fake.add(file);
      f.projectOf.set(r.name, file.project);
    }
    f.loaded.add(r.name);
  }
}

/** remotes.rs `forge_host`: an https or http remote keeps a port that isn't its scheme's default. */
function forgeHost(url: string, host: string): string {
  const i = url.trim().indexOf('://');
  if (i < 0) return host;
  const scheme = asciiLower(url.trim().slice(0, i));
  const def = scheme === 'https' ? '443' : scheme === 'http' ? '80' : null;
  if (def === null) return host;
  const authority = url.trim().slice(i + 3).split('/')[0];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const colon = hostPort.indexOf(':');
  const port = colon < 0 ? '' : hostPort.slice(colon + 1);
  return port !== '' && port !== def && /^[0-9]+$/.test(port) ? `${host}:${port}` : host;
}

/** api.rs `forge_remotes_of` (details.rs `forge_remotes`): the remotes, each host as accounts name it. */
export async function forgeRemotes(ctx: DemoContext, repo: number): Promise<Remotes> {
  const demo = ctx.repos.get(repo);
  const urls = new Map((await demo.remotes()).map((r) => [r.name, r.url]));
  const remotes = (await remotePayloads(demo)).map((r) => {
    const url = urls.get(r.name) ?? null;
    return r.host !== null && url !== null ? { ...r, host: forgeHost(url, r.host) } : r;
  });
  // A read test's context has no profile.
  const chosen = ctx.state.profile?.repos[demo.path]?.forgeTargetRemote ?? null;
  return { remotes, preferred: chosen !== null && remotes.some((r) => r.name === chosen) ? chosen : null };
}

/** hub.rs `accounts`: the demo's one account, always fine. No token, so none to show. */
export function accounts(f: DemoForge): ForgeAccountView[] {
  return [{ account: { host: HOST, kind: 'gitlab', user: f.provider.me(), storage: 'keyring', version: f.fake.seed.version || null, versionCheckedAt: 0, addedAt: 0 }, status: { kind: 'ok' } }];
}

/** hub.rs `account_for`, for the demo's one account. */
const hasAccount = (host: string | null): boolean => host === HOST;

/** hub.rs `target_remote`. */
export function targetRemote(list: RemoteProject[], preferred: string | null): string | null {
  if (preferred !== null && list.some((r) => r.remote === preferred)) return preferred;
  const mapped = list.filter((r) => r.project !== null);
  const origin = mapped.find((r) => r.remote === 'origin');
  if (origin) {
    const project = origin.project!;
    const parent = project.forkOf;
    const up = parent !== null ? mapped.find((r) => r.project!.path === parent && r.project!.host === project.host) : undefined;
    return up ? up.remote : origin.remote;
  }
  for (const m of mapped) {
    const parent = m.project!.forkOf;
    if (parent === null) continue;
    const up = list.find((r) => r.path === parent && r.host === m.host && r.remote !== m.remote);
    if (up) return up.remote;
  }
  const o = list.find((r) => r.remote === 'origin' && r.account !== null && r.host !== null && r.path !== null);
  if (o) return o.remote;
  return mapped[0]?.remote ?? null;
}

function cacheOf(f: DemoForge, path: string): ProjectCache {
  let c = f.cache.get(path);
  if (!c) f.cache.set(path, (c = { project: null, lists: new Map(), open: null, openRefs: new Set(), lookups: new Map() }));
  return c;
}

/** hub.rs `project_on`: the project at `path`, kept for `cached_mrs`; null without an account. */
function projectOn(f: DemoForge, host: string, path: string): ForgeProject | null {
  if (!hasAccount(host)) return null;
  const project = f.provider.project(path);
  cacheOf(f, path).project = project;
  return project;
}

/** hub.rs `repo_projects`. */
export async function repoProjects(f: DemoForge, r: Remotes): Promise<RepoProjects> {
  const remotes = r.remotes.map((x): RemoteProject => {
    const rp: RemoteProject = { remote: x.name, host: x.host, path: x.path, account: null, project: null, error: null };
    if (x.host !== null && x.path !== null) {
      rp.account = hasAccount(x.host) ? 'gitlab' : null;
      if (rp.account !== null) {
        try {
          rp.project = projectOn(f, x.host, x.path);
        } catch (e) {
          if (!isGbError(e)) throw e;
          rp.error = e.message;
        }
      }
    }
    return rp;
  });
  return { remotes, target: targetRemote(remotes, r.preferred), targetChosen: r.preferred !== null };
}

/** hub.rs `cached_forks`: what's known of the remotes' forks without a request (the projects
 * the hub has seen): each remote whose project forks another remote's, the remotes whose project
 * is known not to be a fork, and those the account covers. */
export function cachedForks(f: DemoForge, r: { remotes: RemotePayload[] }): ForkFacts {
  const out: ForkFacts = { parents: {}, roots: [], covered: [] };
  for (const x of r.remotes) {
    if (x.host === null || x.path === null || !hasAccount(x.host)) continue;
    out.covered.push(x.name);
    const project = f.cache.get(x.path)?.project ?? null;
    if (project === null) continue;
    const parent = project.forkOf;
    if (parent === null) {
      out.roots.push(x.name);
      continue;
    }
    const up = r.remotes.find((u) => u.name !== x.name && u.host === x.host && u.path !== null && asciiLower(u.path) === asciiLower(parent));
    if (up) out.parents[x.name] = up.name;
  }
  return out;
}

/** `ForkFacts` equality (the core's sets and map). */
export function sameForks(a: ForkFacts, b: ForkFacts): boolean {
  const set = (xs: string[]) => [...new Set(xs)].sort(compareBytes).join('\n');
  const map = (m: Record<string, string>) => Object.entries(m).sort(([x], [y]) => compareBytes(x, y)).map(([k, v]) => `${k}\t${v}`).join('\n');
  return set(a.roots) === set(b.roots) && set(a.covered) === set(b.covered) && map(a.parents) === map(b.parents);
}

/** hub.rs `project_for_remote`. */
export async function projectForRemote(f: DemoForge, r: { remotes: RemotePayload[] }, remote: string): Promise<ForgeProject> {
  const x = r.remotes.find((y) => y.name === remote) ?? fail('NotFound', `No remote ${remote}`);
  if (x.host === null || x.path === null) fail('InvalidInput', `${remote} isn't on a forge`);
  return projectOn(f, x.host, x.path) ?? fail('NotFound', `No account for ${x.host}: add one in Settings › Accounts`);
}

/** hub.rs `forks_page`: each fork names its parent. */
export async function forksPage(f: DemoForge, r: Remotes, remote: string, page: number, perPage: number): Promise<ForkPage> {
  const project = await projectForRemote(f, r, remote);
  const out = f.provider.forksPage(project, Math.max(1, page), Math.min(100, Math.max(1, perPage)));
  for (const x of out.forks) x.forkOf ??= project.path;
  return out;
}

/** mrs.rs `mr_target`: the target project; without a target, the first remote with an account says why. */
export async function mrTarget(f: DemoForge, r: Remotes): Promise<{ remote: string; project: ForgeProject }> {
  const rp = await repoProjects(f, r);
  const remote = rp.target ?? rp.remotes.find((x) => x.account !== null)?.remote ?? fail('InvalidInput', NO_TARGET);
  return { remote, project: await projectForRemote(f, r, remote) };
}

/** mrs.rs `ForgeHub::wrote` (cache.rs `forget_lists`): a write forgets the target's kept lists. */
export function wrote(f: DemoForge, projectPath: string): void {
  const c = cacheOf(f, projectPath);
  c.lists.clear();
  c.open = null;
}

export const fresh = <T>(f: DemoForge, value: T): Fresh<T> => ({ value, notModified: false, pollIntervalSecs: null, fetchedAt: f.clock() });

/** mrs.rs `mr_list`. */
export async function mrList(f: DemoForge, r: Remotes, filter: MrFilter): Promise<MrList> {
  const t = await mrTarget(f, r);
  const mrs = f.provider.openMrs(t.project, filter, true);
  const fetchedAt = f.clock();
  const c = cacheOf(f, t.project.path);
  c.lists.set(filter, { mrs, fetchedAt });
  c.project = t.project;
  return { kind: t.project.kind, remote: t.remote, project: t.project, filter, mrs, fetchedAt, pollIntervalSecs: null, rateLimit: { limitedUntil: null, remaining: 2000, resetAt: null, limit: 2000 } };
}

const TRUNKS = ['main', 'master', 'trunk'];

/** mrs.rs `badge_refs`: each asked remote-tracking ref's tip (its own commit, or when it's gone,
 * those of the local branches that track it or push to it), and the stack base. */
export async function badgeRefs(repo: DemoRepo, asked: string[]): Promise<BadgeRefs> {
  const files = repo.refFiles();
  const rr = await repo.graphRefs(files, repo.refMap(files));
  const remoteTips = new Map(rr.refs.filter((x) => x.kind.type === 'remote').map((x) => [x.fullName, x.target]));
  const locals = rr.refs.filter((x) => x.kind.type === 'local');
  const tips = new Map<string, string[]>();
  // Each local branch's push target, read once (and only when a ref is gone).
  let pushes: (string | null)[] | null = null;
  for (const want of asked) {
    const own = remoteTips.get(want);
    if (own !== undefined) {
      tips.set(want, [own]);
      continue;
    }
    pushes ??= await Promise.all(locals.map(async (l) => {
      const p = await pushTarget(repo, l.shortName);
      return p === null ? null : `refs/remotes/${p.remote}/${p.branch}`;
    }));
    const p = pushes;
    tips.set(want, locals.filter((l, i) => l.upstream === want || p[i] === want).map((l) => l.target));
  }
  // `stackBase`: a remote's default branch, origin first; else `<remote>/main|master|trunk`.
  const names = (await repo.remotes()).map((x) => x.name).sort((a, b) => Number(a !== 'origin') - Number(b !== 'origin') || compareBytes(a, b));
  let stackBase: string | null = null;
  for (const n of names) {
    const d = rr.remoteHeads[n];
    if (d !== undefined && remoteTips.has(d)) {
      stackBase = d;
      break;
    }
  }
  if (stackBase === null) {
    outer: for (const n of names) {
      for (const b of TRUNKS) {
        if (remoteTips.has(`refs/remotes/${n}/${b}`)) {
          stackBase = `refs/remotes/${n}/${b}`;
          break outer;
        }
      }
    }
  }
  return { tips, stackBase };
}

/** mrs.rs `split_remote_ref`: the longest remote name that fits. */
function splitRemoteRef(full: string, remotes: string[]): [string, string] | null {
  if (!full.startsWith('refs/remotes/')) return null;
  const rest = full.slice('refs/remotes/'.length);
  let best: string | null = null;
  for (const r of remotes) if (rest.length > r.length + 1 && rest.startsWith(r) && rest[r.length] === '/' && (best === null || r.length >= best.length)) best = r;
  return best === null ? null : [best, rest.slice(best.length + 1)];
}

/** `BadgeRefs::badges`: an open MR badges its ref; a merged or closed one only while its head is that ref's tip. */
function badges(repo: BadgeRefs, remoteRef: string, mr: ForgeMr): boolean {
  if (mr.state === 'open' || mr.state === 'draft') return true;
  const head = mr.headSha;
  if (head === null) return false;
  return (repo.tips.get(remoteRef) ?? []).some((t) => asciiLower(t) === asciiLower(head));
}

/** mrs.rs `BadgePlan`: `onHost` is the remotes on the target's host whose project is known, (remote, project path). */
class BadgePlan {
  readonly covered: Set<string>;
  readonly wanted: [string, string, string][];
  readonly onHost: [string, string][];

  constructor(target: ForgeProject, open: ForgeMr[], onHost: [string, string][], refs: string[], repo: BadgeRefs) {
    // Never looked up in any state: the target project's default branch (on each remote of that
    // project) and the stack base. An open MR from one still badges it.
    const trunks = new Set(repo.stackBase !== null ? [repo.stackBase] : []);
    if (target.defaultBranch !== null) for (const [r, path] of onHost) if (path === target.path) trunks.add(`refs/remotes/${r}/${target.defaultBranch}`);
    this.covered = new Set(open.flatMap((m) => onHost.filter(([, path]) => path === m.sourceProject).map(([r]) => `refs/remotes/${r}/${m.sourceBranch}`)));
    const names = onHost.map(([r]) => r);
    this.wanted = refs.filter((r) => !this.covered.has(r) && !trunks.has(r)).flatMap((r) => {
      const s = splitRemoteRef(r, names);
      return s ? [[r, s[0], s[1]] as [string, string, string]] : [];
    });
    this.onHost = onHost;
  }

  /** The badges and the history: the open list's, then the wanted refs' lookups. */
  place(open: ForgeMr[], known: Map<string, RefLookup>, repo: BadgeRefs): [RefMr[], RefMr[]] {
    const out: RefMr[] = [];
    const history: RefMr[] = [];
    const put = (remoteRef: string, mr: ForgeMr) => (badges(repo, remoteRef, mr) ? out : history).push({ remoteRef, mr });
    for (const m of open) for (const [r, path] of this.onHost) if (path === m.sourceProject) put(`refs/remotes/${r}/${m.sourceBranch}`, m);
    for (const [full] of this.wanted) {
      const m = known.get(full)?.mr;
      if (m) put(full, m);
    }
    return [out, history];
  }
}

/** cache.rs `RefLookup::fresh`: an open one never is. */
function lookupFresh(l: RefLookup, tips: string[], now: number): boolean {
  const s = l.mr?.state ?? null;
  if (s === 'open' || s === 'draft' || s === 'merging') return false;
  const ttl = s === null ? LOOKUP_NONE_SECS : LOOKUP_DONE_SECS;
  return l.tips.length === tips.length && l.tips.every((t, i) => t === tips[i]) && now - l.at < ttl;
}

/** mrs.rs `branch_mrs`: the badges. */
export async function branchMrs(f: DemoForge, r: Remotes, refs: string[], repo: BadgeRefs): Promise<BranchMrs> {
  const t = await mrTarget(f, r);
  const open = f.provider.openMrs(t.project, 'all', false);
  const fetchedAt = f.clock();
  const rp = await repoProjects(f, r);
  const onHost = rp.remotes.flatMap((x): [string, string][] => (x.project && x.project.host === t.project.host ? [[x.remote, x.project.path]] : []));
  const plan = new BadgePlan(t.project, open, onHost, refs, repo);
  // Asked: a ref the last open list badged and this one doesn't (just merged or closed), then one
  // never asked, moved since, or whose answer is too old; the rest answer from the cache.
  const c = cacheOf(f, t.project.path);
  const wasOpen = c.openRefs;
  const known = c.lookups;
  const now = f.clock();
  const tipsOf = (full: string) => repo.tips.get(full) ?? [];
  const ask = plan.wanted.filter(([full]) => wasOpen.has(full) || !(known.has(full) && lookupFresh(known.get(full)!, tipsOf(full), now)));
  ask.sort((a, b) => Number(!wasOpen.has(a[0])) - Number(!wasOpen.has(b[0])));
  for (const [full, remote, branch] of ask.slice(0, BRANCH_LOOKUPS)) {
    const path = onHost.find(([x]) => x === remote)?.[1];
    if (path === undefined) continue;
    try {
      known.set(full, { tips: tipsOf(full), mr: f.provider.mrForBranch(t.project, { project: path, branch }), at: now });
    } catch (e) {
      // A refused token or a limit ends the lookups; any other failure skips only that branch.
      if (!isGbError(e)) throw e;
      if (e.kind === 'AuthFailed' || e.kind === 'RateLimited') break;
    }
  }
  // Only the refs asked about now are kept (a deleted branch's lookup goes with it).
  const asked = new Set(plan.wanted.map(([full]) => full));
  for (const k of [...known.keys()]) if (!asked.has(k)) known.delete(k);
  const [mrs, history] = plan.place(open, known, repo);
  c.openRefs = plan.covered;
  c.lookups = known;
  c.open = { mrs: open, fetchedAt };
  c.project = t.project;
  return { kind: t.project.kind, remote: t.remote, mrs, history, fetchedAt, pollIntervalSecs: null };
}

/** mrs.rs `cached_mrs`: the list and badges as the last poll left them, for the target as it's
 * chosen now, with no request; the badges placed for the refs' tips now. */
export function cachedMrs(f: DemoForge, r: Remotes, refs: string[], repo: BadgeRefs, filter: MrFilter): CachedMrs | null {
  const known = (x: RemotePayload): ForgeProject | null => (hasAccount(x.host) && x.path !== null ? (f.cache.get(x.path)?.project ?? null) : null);
  const list = r.remotes.map((x): RemoteProject => {
    const account = x.host !== null && hasAccount(x.host) ? ('gitlab' as const) : null;
    return { remote: x.name, host: x.host, path: x.path, account, project: account !== null ? known(x) : null, error: null };
  });
  const remote = targetRemote(list, r.preferred);
  if (remote === null) return null;
  const at = r.remotes.find((x) => x.name === remote);
  const project = at ? known(at) : null;
  if (project === null) return null;
  const onHost = list.flatMap((x): [string, string][] => (x.project && x.project.host === project.host ? [[x.remote, x.project.path]] : []));
  const c = cacheOf(f, project.path);
  const stored = c.lists.get(filter) ?? null;
  if (stored === null && c.open === null) return null;
  const mrList: MrList | null = stored === null ? null : { kind: project.kind, remote, project, filter, mrs: stored.mrs, fetchedAt: stored.fetchedAt, pollIntervalSecs: null };
  let badgeList: BranchMrs | null = null;
  if (c.open !== null) {
    const plan = new BadgePlan(project, c.open.mrs, onHost, refs, repo);
    const [mrs, history] = plan.place(c.open.mrs, c.lookups, repo);
    badgeList = { kind: project.kind, remote, mrs, history, fetchedAt: c.open.fetchedAt, pollIntervalSecs: null };
  }
  const savedAt = Math.min(...[mrList?.fetchedAt, badgeList?.fetchedAt].filter((x): x is number => x !== undefined));
  return { kind: project.kind, remote, project, list: mrList, badges: badgeList, savedAt };
}

// --- creating (4C T5: hub.rs `create_context`, create.rs `first_commit`) ---
/** The core's create.rs `split_message`. */
export function splitMessage(message: string): [string, string] {
  const text = message.replace(/\r\n/g, '\n').replace(/\s+$/u, '');
  const nl = text.indexOf('\n');
  if (nl < 0) return [text, ''];
  let body = text.slice(nl + 1);
  while (body.includes('\n') && body.slice(0, body.indexOf('\n')).trim() === '') body = body.slice(body.indexOf('\n') + 1);
  return [text.slice(0, nl).replace(/\s+$/u, ''), body.trim() === '' ? '' : body];
}

/** create.rs `first_commit`: the oldest non-merge commit on `branch`'s first-parent line since the first of `bases` that exists. */
export async function firstCommit(read: ReadRepo, root: string, branch: string, bases: string[]): Promise<FirstCommit | null> {
  let base: string | null = null;
  for (const b of bases) {
    base = await revParse(read, `${b}^{commit}`, root).catch(() => null);
    if (base) break;
  }
  const tip = (await refsUnder(read, 'refs/heads')).find((h) => h.name === `refs/heads/${branch}`)?.oid;
  if (!base || !tip) return null;
  const hidden = await ancestors(read, base);
  const chain: string[] = [];
  for (let at: string | undefined = tip; at && !hidden.has(at); ) {
    const c = await readCommit(read, at);
    if (c.parents.length < 2) chain.push(at);
    at = c.parents[0];
  }
  if (chain.length === 0) return null;
  const [summary, body] = splitMessage((await readCommit(read, chain[chain.length - 1])).rawMessage);
  return { summary, body, count: chain.length };
}

/** hub.rs `create_context`: the target project and its settings, the source project, the target branch's templates and the branch's first commit since its target. */
export async function createContext(ctx: DemoContext, f: DemoForge, repo: number, r: Remotes, ask: { remote: string; sourceRemote: string; branch: string; target: string }): Promise<CreateContext> {
  const source = r.remotes.find((x) => x.name === ask.sourceRemote) ?? fail('NotFound', `No remote ${ask.sourceRemote}`);
  const sourceProject = source.path ?? fail('InvalidInput', `${ask.sourceRemote} isn't on a forge`);
  const project = await projectForRemote(f, r, ask.remote);
  // Host names without the port: an SSH remote and an HTTPS one on `h:8443` are the same forge.
  const host = (name: string) => r.remotes.find((x) => x.name === name)?.host?.split(':')[0].toLowerCase() ?? null;
  if (host(ask.sourceRemote) !== host(ask.remote)) fail('InvalidInput', `${ask.sourceRemote} isn't on ${project.host}: choose a remote on the same forge`);
  const settings = f.provider.projectSettings(project);
  const templates = f.provider.mrTemplates(project);
  const demo = ctx.repos.get(repo);
  const first = await firstCommit(viewOf(demo), demo.path, ask.branch, [`refs/remotes/${ask.remote}/${ask.target}`, `refs/heads/${ask.target}`]);
  return { project, sourceProject, settings, templates, templatesLocal: false, firstCommit: first };
}
