/**
 * The line "Open in…" opens a diffed file at (H9): the first line of `modified` that differs
 * from `original` (1-based), or `null` when they're the same. A change past `modified`'s end
 * (only lines removed at the end) gives its last line. A plain line compare, not Monaco's diff:
 * enough to land the editor on the first change.
 */
export function firstChangedLine(original: string, modified: string): number | null {
  if (original === modified) return null;
  const a = original.split('\n');
  const b = modified.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  // A final newline leaves an empty last element, which isn't a line.
  const lines = b.length > 1 && b[b.length - 1] === '' ? b.length - 1 : b.length;
  return Math.max(1, Math.min(i + 1, lines));
}
