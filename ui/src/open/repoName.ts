/** Destination folder name for a clone URL (spec §13 "name from URL"). */
export function repoNameFromUrl(url: string): string {
  const s = url.trim().replace(/[/\\]+$/, '').replace(/\.git$/i, '');
  const last = s.split(/[/:\\]/).pop() ?? '';
  return last.replace(/[^\w.-]/g, '');
}
