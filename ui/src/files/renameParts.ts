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

/** A path as `[common prefix, changed part, common suffix]`; the three join back to the path. */
export type HighlightParts = [string, string, string];

const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
/** Whether a cut at `i` in `s` (code points) falls between two letters/digits. */
const splitsWord = (s: string[], i: number) => i > 0 && isWord(s[i - 1]) && isWord(s[i]);

/**
 * What a rename changed, for its tooltip (feedback J15): each path split into the prefix and
 * suffix both paths share (shown dimmed) and the part in between that changed. Character-level,
 * so the change can be a directory in the middle, a file name, part of one, or an extension; the
 * prefix and suffix never overlap in either path. Each changed part is widened to whole words
 * (runs of letters and digits), so `Dspn_3uo.js` → `DYuKwOSt.js` highlights `Dspn_3uo` and
 * `DYuKwOSt`, never `spn_3uo`. A side can be empty (`a/x` → `a/b/x`: only the new `b/`).
 */
export function renameHighlight(oldPath: string, newPath: string): { old: HighlightParts; new: HighlightParts } {
  // Code points, not UTF-16 units: a cut never splits a surrogate pair (😀 / 😁 share their high
  // surrogate), and astral letters count as letters.
  const a = Array.from(oldPath);
  const b = Array.from(newPath);
  const min = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < min && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (pre + suf < min && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  // Both paths share the cuts, so a cut that splits a word in either path moves for both. Moving
  // them only ever shrinks the prefix and suffix, so they still never overlap.
  while (pre > 0 && (splitsWord(a, pre) || splitsWord(b, pre))) pre--;
  while (suf > 0 && (splitsWord(a, a.length - suf) || splitsWord(b, b.length - suf))) suf--;
  const parts = (p: string[]): HighlightParts => [p.slice(0, pre).join(''), p.slice(pre, p.length - suf).join(''), p.slice(p.length - suf).join('')];
  return { old: parts(a), new: parts(b) };
}

/** The image formats the image diff shows, by extension, as people name them. */
const IMAGE_FORMATS: Record<string, string> = { png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP', avif: 'AVIF', bmp: 'BMP', ico: 'ICO', svg: 'SVG' };
const formatOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (IMAGE_FORMATS[name.slice(dot + 1).toLowerCase()] ?? null) : null;
};

/** An image converted to another format (`PNG → WebP`): a rename the file list pairs from a
 * deleted and an added image (diff.rs, `pair_image_conversions`). `null` for anything else. */
export function formatChange(oldPath: string, path: string): string | null {
  const [from, to] = [formatOf(oldPath), formatOf(path)];
  return from && to && from !== to ? `${from} → ${to}` : null;
}
