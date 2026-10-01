import type { HostKind } from '../api/gen/HostKind';
import type { RemotePayload } from '../api/gen/RemotePayload';

/** A remote resolved down to what forge URLs need (spec §14.4). */
export interface ProjectRemote {
  host: string;
  path: string;
  hostKind: HostKind;
}

/** The profile's host → forge type overrides (spec §14.4, `Profile.hostOverrides`). */
export type HostOverrides = { [host in string]?: HostKind };

/** A host's forge type: the profile's override for that host (hosts compare case-insensitively),
 * else the one detected from its name. Every forge link, icon and menu row goes through this. */
export function effectiveKind(host: string | null | undefined, detected: HostKind, overrides: HostOverrides): HostKind {
  if (!host) return detected;
  return overrides[host] ?? overrides[host.toLowerCase()] ?? detected;
}

/** The remote that forge links point at: the first with a parsed host and path. Remotes arrive
 * `origin` first (spec §14.4). `overrides` are the profile's host-type overrides. */
export function projectRemote(remotes: RemotePayload[], overrides: HostOverrides = {}): ProjectRemote | null {
  const r = remotes.find((x) => x.host && x.path);
  return r ? { host: r.host!, path: r.path!, hostKind: effectiveKind(r.host, r.hostKind, overrides) } : null;
}

/** Percent-encodes each `/`-separated segment, keeping the separators themselves, so a branch or
 * file path containing `#`, spaces or other reserved characters can't break the URL. */
function encodeSegments(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** `https://{host}/{path}`. `project`, when given, replaces `r.path`. */
function baseUrl(r: ProjectRemote, project?: string | null): string {
  return `https://${r.host}/${project ?? r.path}`;
}

/** A file's blob URL, with an optional line anchor (spec §14.4). GitLab and GitHub differ in both
 * the path shape and the anchor: GitLab's range anchor has one `L`, GitHub's has two. */
export function fileUrl(r: ProjectRemote, ref: string, file: string, lines?: { a: number; b: number }): string | null {
  if (r.hostKind === 'generic') return null;
  const encRef = encodeSegments(ref);
  const encFile = encodeSegments(file);
  if (r.hostKind === 'gitlab') {
    const url = `${baseUrl(r)}/-/blob/${encRef}/${encFile}`;
    if (!lines) return url;
    return `${url}#L${lines.a}${lines.a === lines.b ? '' : `-${lines.b}`}`;
  }
  const url = `${baseUrl(r)}/blob/${encRef}/${encFile}`;
  if (!lines) return url;
  return `${url}#L${lines.a}${lines.a === lines.b ? '' : `-L${lines.b}`}`;
}

/** The project's home page (a remote's Forge link). */
export function repoUrl(r: ProjectRemote): string | null {
  return r.hostKind === 'generic' ? null : baseUrl(r);
}

export function branchUrl(r: ProjectRemote, branch: string): string | null {
  if (r.hostKind === 'generic') return null;
  const enc = encodeSegments(branch);
  return r.hostKind === 'gitlab' ? `${baseUrl(r)}/-/tree/${enc}` : `${baseUrl(r)}/tree/${enc}`;
}

export function commitUrl(r: ProjectRemote, sha: string): string | null {
  if (r.hostKind === 'generic') return null;
  return r.hostKind === 'gitlab' ? `${baseUrl(r)}/-/commit/${sha}` : `${baseUrl(r)}/commit/${sha}`;
}

/** GitLab merge requests; GitHub pull requests (GitHub redirects `/pull/n` to the issue when `n`
 * is one). No API call: plain URL templates (spec §14.4). `project` (a `group/sub/project` or
 * `owner/repo` override) replaces `r.path` when it's non-null. */
export function mergeRequestUrl(r: ProjectRemote, project: string | null, n: number): string | null {
  if (r.hostKind === 'generic') return null;
  return r.hostKind === 'gitlab' ? `${baseUrl(r, project)}/-/merge_requests/${n}` : `${baseUrl(r, project)}/pull/${n}`;
}

export function issueUrl(r: ProjectRemote, project: string | null, n: number): string | null {
  if (r.hostKind === 'generic') return null;
  return r.hostKind === 'gitlab' ? `${baseUrl(r, project)}/-/issues/${n}` : `${baseUrl(r, project)}/issues/${n}`;
}
