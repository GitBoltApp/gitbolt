/** Folder paths from the OS (repo, worktree, clone paths), not repository-relative ones (git
 * always gives those with `/`). A path is Windows-style only with a drive letter or `\\server`;
 * elsewhere `\` is an ordinary character in a name. */
const isWin = (p: string) => /^([A-Za-z]:|\\\\)/.test(p);
const seps = (p: string) => (isWin(p) ? /[\\/]/ : /\//);
const trailing = (p: string) => new RegExp(`(${seps(p).source})+$`);

export const basename = (p: string) => p.replace(trailing(p), '').split(seps(p)).pop() || p;

/** The containing folder; '' for a top-level name. */
export function dirname(p: string): string {
  const t = p.replace(trailing(p), '');
  const i = isWin(t) ? Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')) : t.lastIndexOf('/');
  return i < 0 ? '' : t.slice(0, i);
}

/** `rel` (written with `/`) under `base`, joined with the separator `base` uses. */
export function joinPath(base: string, rel: string): string {
  const sep = isWin(base) && base.includes('\\') ? '\\' : '/';
  const b = base.replace(trailing(base), '');
  return `${b}${sep}${sep === '\\' ? rel.replace(/\//g, '\\') : rel}`;
}

export type OsKind = 'windows' | 'linux';
export const osKind = (): OsKind => (typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) ? 'windows' : 'linux');

/** A placeholder path for the platform: `examplePath('repos')` is `/home/you/repos` or `C:\Users\you\repos`. */
export const examplePath = (rel: string, os: OsKind = osKind()): string =>
  os === 'windows' ? `C:\\Users\\you\\${rel.replace(/\//g, '\\')}` : `/home/you/${rel}`;
