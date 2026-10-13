import type { ForgeKind } from '../api/gen/ForgeKind';
import type { LocateResult } from '../api/gen/LocateResult';
import { shortSha } from '../format/sha';
import { forgeName, mrRef } from '../forge/labels';
import { mrUrl } from '../markdown/links';
import type { ForgeProjectRef, GotoTarget, LineRange } from './classify';

/** A tab's forge project: its kind, `group/project` and web URL (no trailing slash). */
export interface GotoForge { kind: ForgeKind; path: string; webUrl: string }

/** An open repository tab, as the clipboard's target is looked for in it. */
export interface GotoTab {
  tabId: string;
  /** The active tab (listed first). */
  active: boolean;
  /** Shown this session: its graph, remotes and forge project are loaded. */
  loaded: boolean;
  /** The tab's name, for the messages. */
  name: string;
  /** The repository's path (its main worktree). */
  path: string;
  /** Its open handle; null until the repository is opened. */
  repo: number | null;
  /** The tab's active worktree. */
  worktree: string;
  /** Every worktree of its repository that's known: the active one, the main one, the linked ones. */
  worktrees: string[];
  /** The branch checked out in `worktree` (`main`); null when detached or not known. */
  branch: string | null;
  /** Its remotes' parsed URLs (`host`, `group/project`). */
  remotes: Array<{ host: string; path: string }>;
  /** The project its MRs/PRs live in, once known. */
  forge: GotoForge | null;
}

export interface GotoEnv {
  /** The open repository tabs, the active one first (when it's a repository tab). */
  tabs(): GotoTab[];
  /** A tab not shown yet, read cheaply (`api.peekRepo`, no handle): its remotes and checked-out
   * branch. Null when that fails. */
  peek(tab: GotoTab): Promise<GotoTab | null>;
  /** A tab not shown yet whose remotes may hold a forge URL's project: its repository opened (no
   * graph) and its forge project read. Null when that fails. */
  load(tab: GotoTab): Promise<GotoTab | null>;
  /** The repository at `path` opened (no graph): its handle, or null. */
  open(path: string): Promise<number | null>;
  /** `api.locateCommit`; null when it isn't a commit there (or the tab has no graph yet). */
  locate(repo: number, sha: string): Promise<LocateResult | null>;
  /** The commit a local branch, remote branch (`origin/x`) or tag of the tab points at. */
  refTip(tabId: string, name: string): string | null;
  /** The worktree's tracked files (`api.worktreeFiles`). */
  files(repo: number, worktree: string): Promise<string[]>;
  /** What `path` is in the worktree, tracked or not (`api.worktreePathKind`); null: nothing there. */
  pathKind(repo: number, worktree: string, path: string): Promise<'file' | 'dir' | null>;
  /** Paths compare without case (Windows, macOS). */
  caseless: boolean;
}

export type GotoAction =
  /** Select `sha` in the tab's graph; `limit`: the window deep enough to hold it, when known.
   * `missing`: what to say if it isn't there after all (a tab whose graph wasn't loaded to look). */
  | { kind: 'commit'; tabId: string; sha: string; limit: number | null; missing: { message: string; url: string | null } | null }
  /** Open MR/PR `number` of `project` in the tab, once the forge says it is one; `url` its page. */
  | { kind: 'mr'; tabId: string; number: number; forge: ForgeKind; project: string; url: string }
  /** An existing file. `note`: said once it's open (a forge page of another ref shows the working copy). */
  | { kind: 'file'; tabId: string; worktree: string; path: string; lines: LineRange | null; note: string | null }
  /** An existing folder; `path` '' is the worktree itself: only the tab and worktree switch. */
  | { kind: 'folder'; tabId: string; worktree: string; path: string }
  | { kind: 'toast'; message: string; url: string | null }
  | { kind: 'none' };

const NONE: GotoAction = { kind: 'none' };
const toast = (message: string, url: string | null = null): GotoAction => ({ kind: 'toast', message, url });
const shown = (sha: string) => (sha.length <= 12 ? sha : shortSha(sha));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const activeOf = (tabs: GotoTab[]): GotoTab | undefined => (tabs[0]?.active ? tabs[0] : undefined);
const withoutScheme = (u: string) => u.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What going to `target` means among the open tabs. Reads only (and opens a repository a tab
 * shows but hasn't opened yet, without its graph). */
export async function resolveGoto(target: GotoTarget, env: GotoEnv): Promise<GotoAction> {
  const tabs = env.tabs();
  const active = activeOf(tabs);
  switch (target.kind) {
    case 'none': return NONE;
    case 'ref': {
      const tip = active ? env.refTip(active.tabId, target.name) : null;
      return tip && active ? commit(active.tabId, tip) : NONE;
    }
    case 'commit': return resolveCommit(target, tabs, env);
    case 'mr': return resolveMr(target, tabs, env);
    case 'forgeCommit': {
      const m = await matchTab(tabs, target.at, env, 'commit');
      if (!m.tab) return toast(notOpen(target.at, m.near), target.url);
      if (!m.tab.loaded || m.tab.repo === null) return { ...commit(m.tab.tabId, target.sha), missing: { message: `No commit ${shown(target.sha)} in ${m.tab.name}`, url: target.url } };
      const hit = await findCommit(env, [m.tab], target.sha);
      return hit.kind !== 'none' ? hit : toast(`No commit ${shown(target.sha)} in ${m.tab.name}`, target.url);
    }
    case 'forgeFile': {
      const m = await matchTab(tabs, target.at, env, 'file');
      const tab = m.tab;
      if (!tab) return toast(notOpen(target.at, m.near), target.url);
      const repo = tab.repo ?? (await env.open(tab.path).catch(() => null));
      const files = repo === null ? [] : await env.files(repo, tab.worktree).catch(() => []);
      // The ref may hold slashes (`feature/x`): the first split that names a tracked file wins.
      const known = new Set(files);
      const parts = target.refPath;
      const at = parts.slice(1).findIndex((_, i) => known.has(parts.slice(i + 1).join('/')));
      if (at < 0) return toast(`No file ${parts.slice(1).join('/')} in ${tab.name}`, target.url);
      const ref = parts.slice(0, at + 1).join('/');
      const path = parts.slice(at + 1).join('/');
      // The working copy shows, whatever ref the page was of: said when that's another branch (an
      // unknown checkout says nothing).
      const note = tab.branch !== null && ref !== tab.branch ? `Showing the working copy of ${path}, not ${ref}'s` : null;
      return { kind: 'file', tabId: tab.tabId, worktree: tab.worktree, path, lines: target.lines, note };
    }
    case 'path': return resolvePath(target, tabs, env);
  }
}

const commit = (tabId: string, sha: string) => ({ kind: 'commit' as const, tabId, sha, limit: null, missing: null });

async function resolveCommit(target: Extract<GotoTarget, { kind: 'commit' }>, tabs: GotoTab[], env: GotoEnv): Promise<GotoAction> {
  const searched = tabs.filter((t) => t.loaded && t.repo !== null);
  const hit = await findCommit(env, searched, target.sha);
  if (hit.kind !== 'none') return hit;
  const active = activeOf(tabs);
  const tip = target.ref && active ? env.refTip(active.tabId, target.ref) : null;
  if (tip && active) return commit(active.tabId, tip);
  // A number or a word that happens to be hex isn't worth a message.
  if (target.loose || !searched.length) return NONE;
  // The active repository by name, the rest counted; the tabs not shown yet have no graph to look
  // in: said so rather than "no such commit" there.
  const others = searched.length - 1;
  const unloaded = tabs.length - searched.length;
  const where = `${searched[0].name}${others ? ` or ${others} other open ${others === 1 ? 'repository' : 'repositories'}` : ''}`;
  return toast(`No commit ${shown(target.sha)} in ${where}${unloaded ? `; ${plural(unloaded, 'tab')} not loaded yet` : ''}`);
}

/** The first tab (active first) holding `sha`. A short hash several commits share stops the search. */
async function findCommit(env: GotoEnv, tabs: GotoTab[], sha: string): Promise<GotoAction> {
  for (const tab of tabs) {
    if (tab.repo === null) continue;
    const loc = await env.locate(tab.repo, sha).catch(() => null);
    if (!loc) continue;
    if (loc.ambiguous) return toast(`${sha} is ambiguous in ${tab.name}: paste more of the hash`);
    if (loc.found) return { kind: 'commit', tabId: tab.tabId, sha: loc.id ?? sha, limit: loc.limit, missing: null };
    return toast(`${shown(loc.id ?? sha)} isn't in ${tab.name}'s graph (deeper than 10,000 commits, or on no branch)`);
  }
  return NONE;
}

/** Whether `t`'s forge project is `at`'s, exactly: host and full path. */
const isProject = (t: GotoTab, at: ForgeProjectRef) => t.forge !== null && same(withoutScheme(t.forge.webUrl), `${at.host}/${at.project}`);
/** Whether one of `t`'s remotes is `at`'s project (host and full path). */
const hasRemote = (t: GotoTab, at: ForgeProjectRef) => t.remotes.some((r) => same(r.host, at.host) && same(r.path, at.project));

/**
 * The tab for a forge page of `at`'s project. First, across all tabs, the one whose forge project
 * it is exactly: the tabs shown this session (the active one first), then the others, each read
 * cheaply for its remotes (`peek`), and only those with a remote on `at`'s host opened to read
 * their forge project (`load`). Failing that, by remote: for a commit page any tab with a remote
 * on the project (a fork's `upstream` too; the commit itself is checked there), for a file page
 * one with no forge project of its own. An MR/PR goes by the exact project only; `near` names a
 * tab whose remote was the project, for the message.
 */
async function matchTab(tabs: GotoTab[], at: ForgeProjectRef, env: GotoEnv, page: 'mr' | 'commit' | 'file'): Promise<{ tab: GotoTab | null; near: GotoTab | null }> {
  let seen = tabs.filter((t) => t.loaded);
  const exact = seen.find((t) => isProject(t, at));
  if (exact) return { tab: exact, near: null };
  const rest = tabs.filter((t) => !t.loaded);
  if (rest.length) {
    const peeked = (await Promise.all(rest.map((t) => env.peek(t).catch(() => null)))).filter((t): t is GotoTab => t !== null);
    const onHost = (t: GotoTab) => t.remotes.some((r) => same(r.host, at.host));
    const read = await Promise.all(peeked.map(async (t) => (onHost(t) ? (await env.load(t).catch(() => null)) ?? t : t)));
    const hit = read.find((t) => isProject(t, at));
    if (hit) return { tab: hit, near: null };
    seen = [...seen, ...read];
  }
  const remote = page === 'commit' ? seen.find((t) => hasRemote(t, at)) : page === 'file' ? seen.find((t) => t.forge === null && hasRemote(t, at)) : undefined;
  if (remote) return { tab: remote, near: null };
  return { tab: null, near: seen.find((t) => hasRemote(t, at)) ?? null };
}

function notOpen(at: ForgeProjectRef, near: GotoTab | null): string {
  if (near?.forge) return `${at.project} isn't open here (${near.name}'s project is ${near.forge.path})`;
  if (near) return `No ${forgeName(at.forge)} account for ${near.name}`;
  return `${at.project} isn't open here`;
}

async function resolveMr(target: Extract<GotoTarget, { kind: 'mr' }>, tabs: GotoTab[], env: GotoEnv): Promise<GotoAction> {
  if (target.at) {
    const ref = mrRef(target.at.forge, target.number);
    const m = await matchTab(tabs, target.at, env, 'mr');
    if (m.tab?.forge) return { kind: 'mr', tabId: m.tab.tabId, number: target.number, forge: m.tab.forge.kind, project: m.tab.forge.path, url: target.url! };
    if (m.near && !m.near.forge) return toast(`No ${forgeName(target.at.forge)} account for ${m.near.name}: ${ref} opens in the browser`, target.url);
    return toast(`${ref} belongs to ${target.at.project}, which isn't open here${m.near?.forge ? ` (${m.near.name}'s project is ${m.near.forge.path})` : ''}`, target.url);
  }
  // `!12` / `#12`: the active repository's forge, if its kind writes them that way.
  const active = activeOf(tabs);
  const forge = active?.forge;
  if (!active) return NONE;
  if (!forge) return toast(`${active.name} has no GitLab or GitHub project for ${target.sigil}${target.number}`);
  if ((forge.kind === 'gitlab') !== (target.sigil === '!')) return NONE;
  const root = forge.webUrl.slice(0, forge.webUrl.length - forge.path.length).replace(/\/+$/, '');
  const project = target.project ?? forge.path;
  if (same(project, forge.path)) return { kind: 'mr', tabId: active.tabId, number: target.number, forge: forge.kind, project: forge.path, url: mrUrl(forge.kind, forge.webUrl, target.number) };
  // `group/other!12`: the tab whose project that is, on the same forge.
  const at: ForgeProjectRef = { host: withoutScheme(root).split('/')[0].toLowerCase(), project: `${withoutScheme(root).split('/').slice(1).concat(project).join('/')}`, forge: forge.kind };
  const m = await matchTab(tabs, at, env, 'mr');
  const url = mrUrl(forge.kind, `${root}/${project}`, target.number);
  if (m.tab?.forge) return { kind: 'mr', tabId: m.tab.tabId, number: target.number, forge: m.tab.forge.kind, project: m.tab.forge.path, url };
  return toast(`${mrRef(forge.kind, target.number)} belongs to ${project}, which isn't open here`, url);
}

/** `/`-separated, a drive letter in capitals, no trailing `/`; without case where the file system ignores it. */
function pathKey(p: string, caseless: boolean): string {
  const s = p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`).replace(/\/+$/, '');
  return caseless ? s.toLowerCase() : s;
}

async function resolvePath(target: Extract<GotoTarget, { kind: 'path' }>, tabs: GotoTab[], env: GotoEnv): Promise<GotoAction> {
  let tab: GotoTab | undefined = activeOf(tabs);
  let worktree = tab?.worktree;
  let rel = target.path;
  if (target.absolute) {
    // The deepest worktree holding it (a linked worktree may sit inside the main one); the active
    // tab first, and in a tab its active worktree first.
    const want = pathKey(target.path, env.caseless);
    let best: { tab: GotoTab; worktree: string; depth: number } | null = null;
    for (const t of tabs) {
      for (const w of [t.worktree, ...t.worktrees.filter((x) => x !== t.worktree)]) {
        const k = pathKey(w, env.caseless);
        if ((want === k || want.startsWith(`${k}/`)) && (!best || k.length > best.depth)) best = { tab: t, worktree: w, depth: k.length };
      }
    }
    if (!best) return toast(`${target.path} isn't in an open repository`);
    tab = best.tab;
    worktree = best.worktree;
    rel = target.path.slice(best.depth).replace(/^\/+/, '');
    if (rel === '') return { kind: 'folder', tabId: tab.tabId, worktree, path: '' };
  }
  if (!tab || worktree === undefined) return NONE;
  // A tab not shown yet: its repository opened to look (no graph).
  const repo = tab.repo ?? (await env.open(tab.path).catch(() => null));
  if (repo === null) return NONE;
  const files = await env.files(repo, worktree).catch(() => null);
  if (files) {
    const exact = files.find((f) => f === rel) ?? (env.caseless ? files.find((f) => same(f, rel)) : undefined);
    if (exact !== undefined) return { kind: 'file', tabId: tab.tabId, worktree, path: exact, lines: target.lines, note: null };
    const inside = `${rel}/`;
    const child = files.find((f) => f.startsWith(inside) || (env.caseless && f.toLowerCase().startsWith(inside.toLowerCase())));
    if (child !== undefined) return { kind: 'folder', tabId: tab.tabId, worktree, path: child.slice(0, rel.length) };
  }
  if (!target.absolute && target.ref) {
    const tip = env.refTip(tab.tabId, target.ref);
    if (tip) return commit(tab.tabId, tip);
  }
  // Untracked: a file or folder the worktree has (its metadata only).
  const kind = await env.pathKind(repo, worktree, rel).catch(() => undefined);
  if (kind === 'file') return { kind: 'file', tabId: tab.tabId, worktree, path: rel, lines: target.lines, note: null };
  if (kind === 'dir') return { kind: 'folder', tabId: tab.tabId, worktree, path: rel };
  if (target.loose || files === null || kind === undefined) return NONE;
  return toast(`No file ${rel} in ${tab.name}`);
}
