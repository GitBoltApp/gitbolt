import type { RowPayload } from '../api/gen/RowPayload';

/**
 * Whether commit `a` is an ancestor of (or is) commit `b`, from the loaded graph rows alone (a
 * menu stays synchronous, spec #2 §14). Rows are in topological order, children before parents
 * (core walk.rs), so the walk from `b` down its parents never needs a row below `a`'s: O(rows)
 * at worst, and usually far less. `null`: unknown, `a` or `b` isn't loaded.
 */
export function isAncestorIn(rows: readonly RowPayload[], indexById: ReadonlyMap<string, number>, a: string, b: string): boolean | null {
  if (a === b) return true;
  const ia = indexById.get(a);
  const ib = indexById.get(b);
  if (ia === undefined || ib === undefined) return null;
  if (ib > ia) return false;
  const seen = new Set<number>([ib]);
  const stack = [ib];
  while (stack.length > 0) {
    const i = stack.pop()!;
    for (const p of rows[i].parents) {
      const j = indexById.get(p);
      if (j === undefined || j > ia || seen.has(j)) continue;
      if (j === ia) return true;
      seen.add(j);
      stack.push(j);
    }
  }
  return false;
}
