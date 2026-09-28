/**
 * A rename's paths for the diff header (H21): the directories both share, then
 * `old ⇒ new` with what differs. Whole directories only: `src/app/` and `src/application/` share
 * `src/`. `newDir` + `newName` is the new path's rest, split so the header can highlight only the
 * new file name.
 */
export interface RenameParts { common: string; old: string; newDir: string; newName: string }

export function renameParts(oldPath: string, newPath: string): RenameParts {
  const a = oldPath.split('/');
  const b = newPath.split('/');
  // Directory segments only: the last segment of each path is its file name.
  let n = 0;
  while (n < a.length - 1 && n < b.length - 1 && a[n] === b[n]) n++;
  const common = a.slice(0, n).map((s) => `${s}/`).join('');
  const rest = b.slice(n);
  const newName = rest.pop()!;
  return { common, old: a.slice(n).join('/'), newDir: rest.map((s) => `${s}/`).join(''), newName };
}
