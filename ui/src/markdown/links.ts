import type { ForgeKind } from '../api/gen/ForgeKind';
import { tabStore } from '../app/tabStores';
import { mrRef } from '../forge/labels';
import { forgeOf } from '../forge/mrStore';
import { resolveRepoPath } from './fileContext';
import type { LinkTarget, MarkdownContext, MdReferenceNode } from './types';

/** What resolving needs, pure (the tests build one; `linkEnvOf` reads the stores). */
export interface LinkEnv {
  kind: ForgeKind | null;
  project: { path: string; webUrl: string; defaultBranch: string | null } | null;
  /** The full id of a loaded commit whose id starts with `prefix`, or null. */
  fullSha(prefix: string): string | null;
}

const shaMemo = new WeakMap<Map<string, number>, Map<string, string | null>>();

/** A loaded commit by id prefix, memoized per graph index (a new graph is a new index). */
export function fullShaIn(index: Map<string, number> | undefined, prefix: string): string | null {
  if (!index) return null;
  const p = prefix.toLowerCase();
  if (index.has(p)) return p;
  let memo = shaMemo.get(index);
  if (!memo) shaMemo.set(index, (memo = new Map()));
  const hit = memo.get(p);
  if (hit !== undefined) return hit;
  let found: string | null = null;
  for (const id of index.keys()) if (id.startsWith(p)) { found = id; break; }
  memo.set(p, found);
  return found;
}

export function linkEnvOf(ctx: MarkdownContext): LinkEnv {
  const f = forgeOf(ctx.tabId);
  const index = tabStore(ctx.tabId)?.getState().indexById;
  return {
    kind: f.kind,
    project: f.project ? { path: f.project.path, webUrl: f.project.webUrl.replace(/\/+$/, ''), defaultBranch: f.project.defaultBranch } : null,
    fullSha: (p) => fullShaIn(index, p),
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const dash = (kind: ForgeKind) => (kind === 'gitlab' ? '/-' : '');

/** The forge's web root: `https://github.com` for `https://github.com/o/r` (a GitLab instance may live under a path). */
export function webRoot(p: { path: string; webUrl: string }): string {
  const tail = `/${p.path}`;
  return p.webUrl.toLowerCase().endsWith(tail.toLowerCase()) ? p.webUrl.slice(0, -tail.length) : new URL(p.webUrl).origin;
}
export const mrUrl = (kind: ForgeKind, web: string, n: number) => (kind === 'gitlab' ? `${web}/-/merge_requests/${n}` : `${web}/pull/${n}`);
export const issueUrl = (kind: ForgeKind, web: string, n: number) => `${web}${dash(kind)}/issues/${n}`;
export const commitUrl = (kind: ForgeKind, web: string, sha: string) => `${web}${dash(kind)}/commit/${sha}`;
export const blobUrl = (kind: ForgeKind, web: string, branch: string, path: string) => `${web}${dash(kind)}/blob/${encodeURIComponent(branch)}/${path.replace(/^(\.\/)+/, '').replace(/^\/+/, '')}`;

export function targetOfReference(env: LinkEnv, node: MdReferenceNode): LinkTarget {
  const { kind, project: p } = env;
  if (!kind || !p) {
    if (node.refKind === 'commit' && node.sha) { const full = env.fullSha(node.sha); return full ? { kind: 'commit', sha: full, webUrl: null } : { kind: 'inert' }; }
    return { kind: 'inert' };
  }
  switch (node.refKind) {
    case 'mention':
      return node.user ? { kind: 'external', url: `${webRoot(p)}/${node.user}` } : { kind: 'inert' };
    case 'commit': {
      if (!node.sha) return { kind: 'inert' };
      const full = env.fullSha(node.sha);
      return full ? { kind: 'commit', sha: full, webUrl: null } : { kind: 'commit', sha: node.sha, webUrl: commitUrl(kind, p.webUrl, node.sha) };
    }
    case 'mr':
    case 'issue': {
      if (node.number === null) return { kind: 'inert' };
      const here = node.project === null || same(node.project, p.path);
      const web = here ? p.webUrl : `${webRoot(p)}/${node.project}`;
      if (node.refKind === 'mr') return here ? { kind: 'mr', number: node.number, webUrl: mrUrl(kind, web, node.number) } : { kind: 'external', url: mrUrl(kind, web, node.number) };
      // `#n`: GitHub numbers PRs and issues together (the view tries the PR, else the browser); GitLab's are issues.
      if (kind === 'github' && here) return { kind: 'mr', number: node.number, webUrl: issueUrl(kind, web, node.number) };
      return { kind: 'external', url: issueUrl(kind, web, node.number) };
    }
  }
}

/** This project's MR/PR or commit page, as an in-app target (ruling 13). */
function forgeTarget(env: LinkEnv, url: string): LinkTarget | null {
  const { kind, project: p } = env;
  if (!kind || !p || !url.toLowerCase().startsWith(`${p.webUrl.toLowerCase()}/`)) return null;
  const rest = url.slice(p.webUrl.length + 1).split(/[?#]/)[0];
  const mr = (kind === 'gitlab' ? /^-\/merge_requests\/(\d+)(?:\/|$)/ : /^pull\/(\d+)(?:\/|$)/).exec(rest);
  if (mr) return { kind: 'mr', number: Number(mr[1]), webUrl: url };
  const c = (kind === 'gitlab' ? /^-\/commit\/([0-9a-f]{7,40})(?:\/|$)/ : /^commit\/([0-9a-f]{7,40})(?:\/|$)/).exec(rest);
  if (c) { const full = env.fullSha(c[1]); return { kind: 'commit', sha: full ?? c[1], webUrl: full ? null : url }; }
  return null;
}

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

export function targetOfHref(env: LinkEnv, ctx: MarkdownContext, href: string): LinkTarget {
  const raw = href.trim();
  if (raw === '') return { kind: 'inert' };
  if (raw.startsWith('#')) {
    const id = decode(raw.slice(1));
    return id ? { kind: 'anchor', id: id.startsWith('user-content-') ? id : `user-content-${id}` } : { kind: 'inert' };
  }
  // Browsers drop ASCII whitespace and controls inside a scheme: so does the check.
  const squashed = raw.replace(/[\u0000- \u007f]/g, '');
  // Protocol-relative and backslash forms (`//host`, `\\host`, `/\t/host`) name another host, never a repo path.
  if (/^[\\/]{2}/.test(squashed)) return { kind: 'inert' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(squashed)?.[1]?.toLowerCase();
  if (scheme === 'mailto') return { kind: 'external', url: squashed };
  if (scheme === 'http' || scheme === 'https') return forgeTarget(env, squashed) ?? { kind: 'external', url: squashed };
  if (scheme !== undefined) return { kind: 'inert' };
  // Relative: against the document in File View (the contract's resolveRepoPath), from the
  // repository root in a forge context; above the root, inert.
  // `resolveRepoPath` gets the href as the renderer gave it, less its `#anchor`: it decodes
  // percent-escapes itself (never decode before or after it).
  const hash = href.indexOf('#');
  const path = resolveRepoPath(ctx.kind === 'file' ? ctx.path : '', hash < 0 ? href : href.slice(0, hash));
  if (!path) return { kind: 'inert' };
  return { kind: 'file', path, commit: ctx.kind === 'file' ? ctx.commit : 'worktree', anchor: hash < 0 ? null : decode(href.slice(hash + 1)) || null };
}

/** `a`'s target (spec §4.1's table). `_text` is the link's text: the menu's Copy text uses it. */
export const resolveLink = (ctx: MarkdownContext, href: string, _text: string): LinkTarget => targetOfHref(linkEnvOf(ctx), ctx, href);
export const resolveReference = (ctx: MarkdownContext, node: MdReferenceNode): LinkTarget => targetOfReference(linkEnvOf(ctx), node);

/** Ctrl/Cmd+click's URL: the forge page when there is one, else the external URL, else none. */
export function browserUrlFor(ctx: MarkdownContext, target: LinkTarget): string | null {
  const { kind, project: p } = linkEnvOf(ctx);
  switch (target.kind) {
    case 'mr': return target.webUrl;
    case 'commit': return target.webUrl ?? (kind && p ? commitUrl(kind, p.webUrl, target.sha) : null);
    case 'external': return target.url;
    case 'file': return ctx.kind === 'forge' && kind && p ? blobUrl(kind, p.webUrl, p.defaultBranch ?? 'HEAD', target.path) + (target.anchor ? `#${target.anchor}` : '') : null;
    case 'anchor':
    case 'inert': return null;
  }
}

/** The hover tooltip: the full target first (spec §4.1). */
export function linkTooltip(ctx: MarkdownContext, target: LinkTarget): string | null {
  switch (target.kind) {
    case 'mr': return `Open ${mrRef(forgeOf(ctx.tabId).kind ?? 'gitlab', target.number)} in GitBolt`;
    case 'commit': return target.webUrl ?? `Select ${target.sha.slice(0, 7)} in the graph`;
    case 'file': return ctx.kind === 'file' ? target.path : browserUrlFor(ctx, target);
    case 'anchor': return `Go to #${target.id.replace(/^user-content-/, '')}`;
    case 'external': return target.url;
    case 'inert': return null;
  }
}
