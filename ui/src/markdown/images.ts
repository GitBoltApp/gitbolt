import { api } from '../api/client';
import type { ForgeImage } from '../api/gen/ForgeImage';
import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeProject } from '../api/gen/ForgeProject';
import { forgeOf } from '../forge/mrStore';
import { refreshMr } from '../forge/poll';
import { resolveRepoPath } from './fileContext';
import type { ImageSource, MarkdownContext } from './types';

/** GitHub's image hosts besides github.com (spec §4.2; the core's allowlist decides for real). */
export const GITHUB_IMAGE_HOSTS: ReadonlySet<string> = new Set(['user-images.githubusercontent.com', 'private-user-images.githubusercontent.com', 'raw.githubusercontent.com', 'avatars.githubusercontent.com']);
const DATA_IMAGE = /^data:image\/(png|gif|jpeg|webp);base64,[a-z0-9+/=\s]+$/i;

const parse = (url: string): URL | null => { try { return new URL(url); } catch { return null; } };

/** `u` is on the forge's own hosts: the account host, the project's web host, GitHub's image hosts. */
export function forgeImageHost(kind: ForgeKind | null, project: Pick<ForgeProject, 'host' | 'webUrl'>, u: URL): boolean {
  const web = parse(project.webUrl);
  if (u.host === project.host.toLowerCase() || (web !== null && u.host === web.host)) return true;
  return kind === 'github' && GITHUB_IMAGE_HOSTS.has(u.host);
}

/** Where an image comes from (spec §4.2). */
export function resolveImage(ctx: MarkdownContext, src: string): ImageSource {
  const s = src.trim();
  if (!s) return { kind: 'none' };
  // Browsers drop ASCII whitespace and controls inside a scheme: so does the check (as resolveLink).
  const squashed = s.replace(/[\u0000- \u007f]/g, '');
  // Protocol-relative and backslash forms (`//host`, `\\host`, `/\t/host`) name another host:
  // never a repo path, never loaded (the T4 review).
  if (/^[\\/]{2}/.test(squashed)) return { kind: 'none' };
  if (/^data:/i.test(squashed)) return DATA_IMAGE.test(s) ? { kind: 'data', url: s } : { kind: 'none' };
  const f = forgeOf(ctx.tabId);
  const project = f.project;
  if (/^[a-z][a-z0-9+.-]*:/i.test(squashed)) {
    const u = parse(squashed);
    if (!u || u.username || u.password) return { kind: 'none' };
    const webOrigin = project ? parse(project.webUrl)?.origin ?? null : null;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && webOrigin !== null && u.origin === webOrigin)) return { kind: 'none' };
    if (project && forgeImageHost(f.kind, project, u)) return { kind: 'forge', url: u.href };
    return u.protocol === 'https:' ? { kind: 'remote', url: u.href, host: u.host } : { kind: 'none' };
  }
  if (ctx.kind === 'file') {
    // Against the document (the 5A/5B contract), repo-root-relative; above the root, nothing.
    // `resolveRepoPath` gets the src as written, less its `#fragment`: it decodes percent-escapes
    // itself (never decode before or after it).
    const hash = src.indexOf('#');
    const path = resolveRepoPath(ctx.path, hash < 0 ? src : src.slice(0, hash));
    return path ? { kind: 'repo', path, commit: ctx.commit } : { kind: 'none' };
  }
  // A GitLab upload, by the project's id: `<root>/-/project/<id>/uploads/…` (GitLab 17+ serves
  // only that one to a browser; the core reads either through the API).
  if (project && f.kind === 'gitlab' && /^\/?uploads\//.test(s)) return { kind: 'forge', url: `${gitlabRoot(project)}/-/project/${project.id}/${s.replace(/^\//, '')}` };
  return { kind: 'none' };
}

const fetched = new Map<string, Promise<ForgeImage>>();
const allowed = new Set<string>();
const refreshedAt = new Map<string, number>();

/** One core request per image and consent for the session (an `expired` answer isn't kept). */
export function loadForgeImage(repo: number, url: string, userAllowed: boolean): Promise<ForgeImage> {
  const key = `${repo}\0${userAllowed ? 1 : 0}\0${url}`;
  let p = fetched.get(key);
  if (!p) {
    p = api.forgeImage(repo, url, userAllowed).then((r) => { if (r.kind === 'expired') fetched.delete(key); return r; });
    fetched.set(key, p);
    p.catch(() => fetched.delete(key));
    if (fetched.size > 200) fetched.delete(fetched.keys().next().value!);
  }
  return p;
}

/** "Load image from <host>" was clicked for `url`: it stays loaded for the session. */
export const allowImage = (url: string): void => { allowed.add(url); };
export const imageAllowed = (url: string): boolean => allowed.has(url);

/** A signed attachment URL ran out: the open MR/PR's bodies again (fresh signatures), at most once a minute per tab (ruling 7). */
export function refreshSignedImages(ctx: MarkdownContext, now = Date.now()): void {
  if (ctx.kind !== 'forge') return;
  const n = forgeOf(ctx.tabId).openMr;
  if (n === null) return;
  if (now - (refreshedAt.get(ctx.tabId) ?? -Infinity) < 60_000) return;
  refreshedAt.set(ctx.tabId, now);
  void refreshMr(ctx.tabId, n).catch(() => {});
}

/** Hosts whose image URLs carry a signature that changes each time the body is fetched. */
const SIGNED_IMAGE_HOSTS: ReadonlySet<string> = new Set(['private-user-images.githubusercontent.com']);

/** An image's identity: GitHub's signed attachment URL less its query (a poll re-signs it: the
 * image is the same), else `src` itself. */
export function imageIdentity(src: string): string {
  const u = /^https:/i.test(src) ? parse(src) : null;
  return u && SIGNED_IMAGE_HOSTS.has(u.host) ? `${u.origin}${u.pathname}` : src;
}

/** Signed images shown this session, by identity: a body that remounts with fresh signatures
 * shows them at once while their new URLs load. */
const SHOWN_KEPT = 100;
const shownSigned = new Map<string, string>();
export function rememberShown(identity: string, url: string): void {
  shownSigned.delete(identity);
  shownSigned.set(identity, url);
  if (shownSigned.size > SHOWN_KEPT) shownSigned.delete(shownSigned.keys().next().value!);
}
export const shownBefore = (identity: string): string | null => shownSigned.get(identity) ?? null;

/** Tests. */
export function resetImageSession(): void {
  fetched.clear();
  allowed.clear();
  refreshedAt.clear();
  shownSigned.clear();
}

/** GitLab's root (`https://host`, or `https://host/gitlab` under a relative URL root): the
 * project's web address less its own path. */
function gitlabRoot(project: Pick<ForgeProject, 'webUrl' | 'path'>): string {
  const web = project.webUrl.replace(/\/+$/, '');
  const own = `/${project.path}`;
  return web.toLowerCase().endsWith(own.toLowerCase()) ? web.slice(0, -own.length) : (parse(web)?.origin ?? web);
}
