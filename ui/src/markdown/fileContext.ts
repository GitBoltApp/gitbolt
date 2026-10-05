/** `href` relative to the file `fromFile` (both repo-root-relative), as a normalized
 * repo-root-relative path: `?query` dropped (the caller handles `#anchor`), a leading `/` from the
 * repository root (as on GitHub), `.` and empty segments dropped, `..` climbing. Each segment is
 * percent-decoded here, once, before `.` and `..` are handled: callers pass the href as written
 * and must not decode it themselves. `null` when it climbs above the root, names nothing, or has
 * a segment that doesn't decode or decodes to a `/`, `\` or NUL. Pure and dependency-free (5A/5B
 * contract). */
export function resolveRepoPath(fromFile: string, href: string): string | null {
  const path = href.split('?')[0];
  if (!path) return null;
  const out = path.startsWith('/') ? [] : fromFile.split('/').slice(0, -1).filter((s) => s !== '' && s !== '.');
  for (const raw of path.split('/')) {
    let seg: string;
    try { seg = decodeURIComponent(raw); } catch { return null; }
    if (/[/\\\0]/.test(seg)) return null;
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length > 0 ? out.join('/') : null;
}
