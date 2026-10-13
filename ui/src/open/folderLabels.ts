const trim = (p: string) => p.replace(/[/\\]+$/, '');
const segments = (p: string) => trim(p).split(/[/\\]/).filter(Boolean);

/** Short names for the scanned directories: each one's shortest trailing path that no other shares
 *  (`/home/u/repos` and `/home/u/work` are "repos" and "work"; two `src` folders keep a parent). */
export function folderLabels(folders: string[]): Map<string, string> {
  const segs = folders.map(segments);
  const labels = new Map<string, string>();
  folders.forEach((f, i) => {
    let n = 1;
    const suffix = (s: string[], k: number) => s.slice(-k).join('/');
    while (n < segs[i].length && segs.some((s, j) => j !== i && suffix(s, n) === suffix(segs[i], n))) n++;
    labels.set(f, suffix(segs[i], n) || trim(f) || f);
  });
  return labels;
}

/** The scanned directory a repository was found in: the deepest one containing it (folders may nest). */
export function folderOf(path: string, folders: string[]): string | undefined {
  let best: string | undefined;
  for (const f of folders) {
    const root = trim(f);
    if ((path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) && (!best || root.length > trim(best).length)) best = f;
  }
  return best;
}
