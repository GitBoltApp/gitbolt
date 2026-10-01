import { repoNameFromUrl } from './repoName';

const URL_SCHEME = /^(https?|ssh|git|file):\/\/\S+$/i;
const SCP_STYLE = /^[\w.-]+@[\w.-]+:\S+$/;

/** Why `url` can't be cloned, or null when it can: http(s)/ssh/git/file URLs, scp-style
 * `user@host:path` and absolute local paths, each with a name to give the folder. */
export function cloneUrlProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  const ok = URL_SCHEME.test(u) || SCP_STYLE.test(u) || u.startsWith('/');
  if (!ok || !repoNameFromUrl(u)) return 'Not a repository URL: use https://, ssh://, git@host:path, file:// or an absolute path';
  return null;
}

/** Why `dest` can't be used, or null: it must be an absolute path. */
export function cloneDestProblem(dest: string): string | null {
  const d = dest.trim();
  return !d || d.startsWith('/') ? null : 'The destination must be an absolute path';
}
