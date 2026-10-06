import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { branchMembership, labelsByRow, type BranchMembership } from './membership';

// The graph's per-payload indexes, computed once per payload and shared: GraphView renders
// from them, and the file menu (menu/menuEnv.ts) reads them on a right-click, so the menu
// never pays for them on its first opening (spec §7 latency budget). Keyed by the payload's
// own arrays, so a new payload gets new indexes and an unchanged array keeps its old ones.

const byRowCache = new WeakMap<readonly RefLabel[], Map<number, RefLabel[]>>();

/** `labelsByRow(labels)`, once per labels array. */
export function labelsByRowOf(labels: RefLabel[]): Map<number, RefLabel[]> {
  let m = byRowCache.get(labels);
  if (!m) {
    m = labelsByRow(labels);
    byRowCache.set(labels, m);
  }
  return m;
}

const membershipCache = new WeakMap<readonly RowPayload[], { byRow: Map<number, RefLabel[]>; pinnedRef: string | null; pinnedRemote: string | null; value: (BranchMembership | null)[] }>();

/** `branchMembership(rows, byRow, pinnedRef, pinnedRemote)` (F7), once per rows array and inputs. */
export function membershipOf(rows: RowPayload[], byRow: Map<number, RefLabel[]>, pinnedRef: string | null, pinnedRemote: string | null = null): (BranchMembership | null)[] {
  const hit = membershipCache.get(rows);
  if (hit && hit.byRow === byRow && hit.pinnedRef === pinnedRef && hit.pinnedRemote === pinnedRemote) return hit.value;
  const value = branchMembership(rows, byRow, pinnedRef, pinnedRemote);
  membershipCache.set(rows, { byRow, pinnedRef, pinnedRemote, value });
  return value;
}
