// Remote URLs and upstreams as the core reads them (remotes::parse_remote_url and host_kind,
// refs::remote_id, remote_for and mismatched_upstream, shelldata::tracking_ref, redact::redact).
import type { HostKind } from '../../api/gen/HostKind';

export interface RemoteUrl { host: string; path: string }

/** Rust's `to_ascii_lowercase`: only A-Z change. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

export function parseRemoteUrl(raw: string): RemoteUrl | null {
  const url = raw.trim();
  let host: string;
  let path: string;
  const scheme = url.indexOf('://');
  if (scheme >= 0) {
    if (asciiLower(url.slice(0, scheme)) === 'file') return null;
    const rest = url.slice(scheme + 3);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const authority = rest.slice(0, slash);
    host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0];
    path = rest.slice(slash + 1);
  } else {
    // scp-like `[user@]host:path`, but not a local path
    if (url.startsWith('/') || url.startsWith('.')) return null;
    const colon = url.indexOf(':');
    if (colon < 0) return null;
    const left = url.slice(0, colon);
    if (left.includes('/')) return null;
    host = left.slice(left.lastIndexOf('@') + 1);
    path = url.slice(colon + 1);
  }
  path = path.replace(/^\/+|\/+$/g, '');
  if (path.endsWith('.git')) path = path.slice(0, -4);
  if (!host || !path) return null;
  return { host: asciiLower(host), path };
}

export function hostKind(host: string): HostKind {
  const h = asciiLower(host);
  if (h === 'github.com' || h.endsWith('.github.com')) return 'github';
  if (h === 'gitlab.com' || h.split('.').some((label) => label.includes('gitlab'))) return 'gitlab';
  return 'generic';
}

/** A remote's project as its URL names it: two remotes with the same one are the same project
 * (refs::remote_id). */
export function remoteId(url: string): string {
  const p = parseRemoteUrl(url);
  if (p) return `${p.host}/${asciiLower(p.path)}`;
  const u = url.trim().replace(/\/+$/, '');
  return u.endsWith('.git') ? u.slice(0, -4) : u;
}

/** Rust's `\b` is Unicode-aware, JS's is ASCII-only: a match that starts with a word character
 * must not follow a letter, mark, digit or connector punctuation. */
const NO_WORD_BEFORE = String.raw`(?<![\p{L}\p{M}\p{Nd}\p{Pc}])`;
const HTTP_USERINFO = new RegExp(String.raw`${NO_WORD_BEFORE}(https?:\/\/)[^\/\s@'"]+@`, 'giu');
const URL_PASSWORD = new RegExp(String.raw`${NO_WORD_BEFORE}([a-z][a-z0-9+.\-]*:\/\/)[^\/\s@:'"]*:[^\/\s@'"]*@`, 'giu');
const QUERY_TOKEN = /([?&](?:access_token|private_token|oauth_token|job_token|token|password|passwd|secret|api_key|apikey|key)=)[^&\s'"]+/giu;
const TOKENS = new RegExp(
  String.raw`${NO_WORD_BEFORE}(gl(?:pat|oas|dt|rt|cbt|ptt|ft|imt|agent|soat|ffct)-[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|ATBB[A-Za-z0-9]{24,}|ATATT[A-Za-z0-9_\-=]{20,})`,
  'gu',
);
const AUTH_HEADER = /(authorization:\s*)\S+(\s+\S+)?/giu;

/** Every message, stderr and log line goes through this before it's logged or shown. */
export function redact(s: string): string {
  return s
    .replace(HTTP_USERINFO, '$1***@')
    .replace(URL_PASSWORD, '$1***@')
    .replace(QUERY_TOKEN, '$1***')
    .replace(TOKENS, '***')
    .replace(AUTH_HEADER, '$1***');
}

/** The longest remote name that prefixes `rest` (remote names may contain `/`). */
export function remoteFor(rest: string, remotes: readonly string[]): string | null {
  let best: string | null = null;
  for (const r of remotes) {
    if (rest.length > r.length && rest.startsWith(r) && rest[r.length] === '/' && (best === null || r.length > best.length)) best = r;
  }
  return best;
}

/** `remote/branch` when a branch's upstream has another branch name (refs::mismatched_upstream). */
export function mismatchedUpstream(branch: string, remote: string, merge: string): string | null {
  const name = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : merge;
  return remote !== '' && remote !== '.' && name !== '' && name !== branch ? `${remote}/${name}` : null;
}

/** What the first matching fetch refspec maps `name` to (git's `remote_find_tracking`). Negative
 * refspecs (`^…`) don't stop an upstream from mapping. */
export function trackingRef(fetchSpecs: readonly string[], name: string): string | null {
  for (const raw of fetchSpecs) {
    const s = raw.trim();
    if (s.startsWith('^')) continue;
    const spec = s.replace(/^\++/, '');
    const colon = spec.indexOf(':');
    if (colon < 0) continue;
    const src = spec.slice(0, colon);
    const dst = spec.slice(colon + 1);
    if (dst === '') continue;
    const star = src.indexOf('*');
    if (star < 0) {
      if (src === name) return dst;
      continue;
    }
    const pre = src.slice(0, star);
    const post = src.slice(star + 1);
    if (name.length >= pre.length + post.length && name.startsWith(pre) && name.endsWith(post)) {
      const captured = name.slice(pre.length, name.length - post.length);
      // A function, so a `$` in a captured name is not read as a replacement pattern.
      return dst.replace('*', () => captured);
    }
  }
  return null;
}
