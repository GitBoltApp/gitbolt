import type { ForgeProject } from '../api/gen/ForgeProject';
import { branchNameError } from '../branches/branchName';

/** A remote URL's host and project path: the Rust `parse_remote_url` (core spec §14.4), line for
 * line. `https://`, `ssh://` and scp-style `git@host:path`; `null` for a local path or `file://`. */
export function parseRemoteUrl(url: string): { host: string; path: string } | null {
  const u = url.trim();
  let host: string;
  let path: string;
  const scheme = u.indexOf('://');
  if (scheme >= 0) {
    if (u.slice(0, scheme).toLowerCase() === 'file') return null;
    const rest = u.slice(scheme + 3);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const authority = rest.slice(0, slash);
    host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0] ?? '';
    path = rest.slice(slash + 1);
  } else {
    if (u.startsWith('/') || u.startsWith('.')) return null;
    const colon = u.indexOf(':');
    if (colon < 0) return null;
    const left = u.slice(0, colon);
    if (left.includes('/')) return null;
    host = left.slice(left.lastIndexOf('@') + 1);
    path = u.slice(colon + 1);
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  return host && path ? { host: host.toLowerCase(), path } : null;
}

/** git's rules for `refs/remotes/<name>/…`, said of a remote (the Rust `remote_name_error`). */
export function remoteNameError(name: string, taken: readonly string[]): string | null {
  const ref = branchNameError(name);
  if (ref) return ref.replace(/branch/g, 'remote');
  return taken.includes(name) ? `A remote named ${name} already exists` : null;
}

/** The Rust `remote_url_error`: empty, option-like, or with whitespace or control characters. */
export function remoteUrlError(url: string): string | null {
  if (!url) return "Enter the remote's URL";
  if (url.startsWith('-')) return "A remote URL can't start with -";
  if (/[\s\p{Cc}]/u.test(url)) return "A remote URL can't contain spaces or control characters";
  return null;
}

/** `base` as a remote name (lowercase, unsafe characters as `-`), or `base-2`, `base-3`… when taken. */
export function freeRemoteName(base: string, taken: readonly string[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'remote';
  if (!taken.includes(clean)) return clean;
  for (let n = 2; ; n++) if (!taken.includes(`${clean}-${n}`)) return `${clean}-${n}`;
}

/** How to reach a fork: over SSH when origin is reached over SSH, else HTTPS. */
export function forkCloneUrl(originUrl: string | null | undefined, fork: ForgeProject): string {
  const o = originUrl?.trim() ?? '';
  const ssh = /^ssh:\/\//i.test(o) || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(o) && parseRemoteUrl(o) !== null);
  return ssh && fork.cloneSsh ? fork.cloneSsh : fork.cloneHttps;
}
