import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { RowPayload } from '../../api/gen/RowPayload';
import { useRuntime } from '../../app/runtime';

export interface RangeCommit { sha: string; summary: string }

/** What a branch brings over its target: BranchFlow's footer. */
export interface RangeStats {
  /** Oldest first; null when the loaded graph doesn't reach from the tip down to the base. */
  commits: RangeCommit[] | null;
  files: number;
  added: number;
  deleted: number;
}

/** `loading`, the stats, or `none`: the repository lacks the tip or the base (not fetched). */
export type RangeState = { status: 'loading' } | { status: 'ready'; stats: RangeStats } | { status: 'none' };

const MAX_WALK = 1000;

/**
 * The commits on `tip`'s first-parent line down to `base` (excluded), oldest first, from the
 * graph's rows; null when the walk leaves the loaded graph (a truncated one) or never meets the
 * base (a branch that merged its target in: the base is then on a second parent).
 */
export function commitsBetween(rows: readonly RowPayload[], tip: string, base: string): RangeCommit[] | null {
  if (tip === base) return [];
  const byId = new Map<string, RowPayload>();
  for (const r of rows) if (!r.wip) byId.set(r.id, r);
  const out: RangeCommit[] = [];
  let at: string | undefined = tip;
  while (at && at !== base) {
    const row = byId.get(at);
    if (!row || out.length >= MAX_WALK) return null;
    out.push({ sha: row.id, summary: row.summary });
    at = row.parents[0];
  }
  return at === base ? out.reverse() : null;
}

/**
 * The commits, files and line totals from `tip` (an oid) over its merge base with `baseRef` (a
 * full ref, the target branch's remote-tracking ref): local reads only (`mergeBase`, then the
 * compare file list; the commits come from the loaded graph). Asked again when the tip or the
 * base changes.
 */
/** The last stats per repo, tip and base (a bounded cache, kept across tab switches): a view shown
 * again starts with them instead of a loading state, and refreshes them quietly. */
const seen = new Map<string, RangeState>();
const SEEN_MAX = 200;
const keyOf = (repoId: number, tip: string, baseRef: string) => `${repoId}\0${tip}\0${baseRef}`;
function remember(key: string, state: RangeState) {
  seen.delete(key);
  seen.set(key, state);
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
}

export function useRangeStats(tabId: string, tip: string | null, baseRef: string | null): RangeState {
  const repoId = useRuntime((s) => s.tabs[tabId]?.repo?.id);
  const key = repoId !== undefined && tip && baseRef ? keyOf(repoId, tip, baseRef) : null;
  const [state, setState] = useState<RangeState>(() => (key && seen.get(key)) || { status: 'loading' });
  useEffect(() => {
    if (repoId === undefined || !tip || !baseRef || !key) { setState({ status: 'none' }); return; }
    let live = true;
    // Seen before: show it at once (no loading flash), then refresh it quietly.
    setState(seen.get(key) ?? { status: 'loading' });
    (async () => {
      const base = await api.mergeBase(repoId, baseRef, tip);
      if (!base) return { status: 'none' } as const;
      const list = await api.fileList(repoId, { kind: 'compare', from: base, to: tip });
      const rows = useRuntime.getState().tabs[tabId]?.graph?.rows ?? [];
      return { status: 'ready', stats: { commits: commitsBetween(rows, tip, base), files: list.files.length, added: list.added, deleted: list.deleted } } as const;
    })().then((s) => { remember(key, s); if (live) setState(s); }, () => { if (live) setState(seen.get(key) ?? { status: 'none' }); });
    return () => { live = false; };
  }, [tabId, repoId, tip, baseRef, key]);
  return state;
}

/** For tests: forget the cached stats. */
export function clearRangeStats(): void {
  seen.clear();
}
