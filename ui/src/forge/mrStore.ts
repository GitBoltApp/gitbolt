import { create } from 'zustand';
import type { ForgeDiscussion } from '../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeMr } from '../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../api/gen/ForgeMrDetail';
import type { ForgeProject } from '../api/gen/ForgeProject';
import type { MrFilter } from '../api/gen/MrFilter';
import type { MrList } from '../api/gen/MrList';
import type { SidebarPayload } from '../api/gen/SidebarPayload';

/** The MR/PR view's flyout kind (T12 registers it) and its props. */
export const MR_FLYOUT = 'mr';
export interface MrViewArgs { number: number }

/** One tab's forge state (spec #4 §4 "4B"), kept in memory: the poller fills it. */
export interface TabForge {
  /** The kind of the account behind the repo's target project; null: no MR/PR UI for this repo. */
  kind: ForgeKind | null;
  /** The target remote and its project. */
  remote: string | null;
  project: ForgeProject | null;
  /** The account's username (Approve's "You approved it"). */
  me: string | null;
  /** Remote-tracking ref (`refs/remotes/origin/dev`) → its MR/PR: the badges. */
  byRef: Record<string, ForgeMr>;
  /** Local branch ref → its upstream ref, as the badges were read. */
  upstreams: Record<string, string>;
  /** The sidebar section's filter (T11 keeps it per repository). */
  filter: MrFilter;
  /** The sidebar section's list. */
  list: MrList | null;
  details: Record<number, { value: ForgeMrDetail; at: number }>;
  detailErrors: Record<number, string>;
  discussions: Record<number, ForgeDiscussion[]>;
  /** The MR/PR the tab's flyout shows. */
  openMr: number | null;
  /** ms epoch of the last poll that worked. */
  updatedAt: number | null;
  /** The last poll's failure. The data above stays (spec #4 §6). */
  error: string | null;
  /** Failed polls in a row (the backoff). */
  failures: number;
}

export const EMPTY_FORGE: TabForge = {
  kind: null, remote: null, project: null, me: null, byRef: {}, upstreams: {}, filter: 'all', list: null,
  details: {}, detailErrors: {}, discussions: {}, openMr: null, updatedAt: null, error: null, failures: 0,
};

export const useForge = create<{ byTab: Record<string, TabForge> }>(() => ({ byTab: {} }));
export const forgeOf = (tabId: string): TabForge => useForge.getState().byTab[tabId] ?? EMPTY_FORGE;
export const useTabForge = (tabId: string): TabForge => useForge((s) => s.byTab[tabId] ?? EMPTY_FORGE);

/** One tab's field, so a view re-renders only when that field changes. */
export const useTabForgeField = <K extends keyof TabForge>(tabId: string, key: K): TabForge[K] => useForge((s) => (s.byTab[tabId] ?? EMPTY_FORGE)[key]);

/** Structural equality of plain data (the answers are JSON). */
export const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
/** `next`, unless it equals `old`: then `old`, so an unchanged answer keeps its identity. */
export const keepSame = <T,>(old: T, next: T): T => (sameJson(old, next) ? old : next);

/** Per-MR load bookkeeping outside the store (it must not re-render anything). */
export const forgeScratch = { loading: new Map<string, Promise<void>>(), freshAt: new Map<string, number>() };

/** A closed tab's forge state goes with it. */
export function dropForge(tabId: string): void {
  useForge.setState((s) => {
    if (!(tabId in s.byTab)) return s;
    const byTab = { ...s.byTab };
    delete byTab[tabId];
    return { byTab };
  });
  for (const m of [forgeScratch.loading, forgeScratch.freshAt]) for (const k of [...m.keys()]) if (k.startsWith(`${tabId}:`)) m.delete(k);
}

export function patchForge(tabId: string, patch: Partial<TabForge> | ((f: TabForge) => Partial<TabForge>)): void {
  useForge.setState((s) => {
    const cur = s.byTab[tabId] ?? EMPTY_FORGE;
    const p = typeof patch === 'function' ? patch(cur) : patch;
    if ((Object.keys(p) as (keyof TabForge)[]).every((k) => p[k] === cur[k])) return s;
    return { byTab: { ...s.byTab, [tabId]: { ...cur, ...p } } };
  });
}

/** A chip's or a branch's MR/PR: through one of its remote refs (`via` that ref), else through
 * its local branch's upstream (`via: 'local'`). The badge takes the place of that ref's icon. */
export function mrForLabel(f: TabForge, label: { local: string | null; remotes: ReadonlyArray<{ fullName: string }> }): { mr: ForgeMr; via: string } | null {
  for (const r of label.remotes) {
    const mr = f.byRef[r.fullName];
    if (mr) return { mr, via: r.fullName };
  }
  const up = label.local ? f.upstreams[label.local] : undefined;
  const mr = up ? f.byRef[up] : undefined;
  return mr ? { mr, via: 'local' } : null;
}

export const mrForUpstream = (f: TabForge, upstream: string | null | undefined): ForgeMr | null => (upstream ? f.byRef[upstream] ?? null : null);

/** An MR/PR by number from what's loaded: its detail, the list, a badge. */
export function knownMr(f: TabForge, n: number): ForgeMr | null {
  return f.details[n]?.value.mr ?? f.list?.mrs.find((m) => m.number === n) ?? Object.values(f.byRef).find((m) => m.number === n) ?? null;
}

/** The local branches' upstreams (gone ones too: a merged MR's branch), newest tip first: what
 * the badges look up. */
export function upstreamRefsOf(sidebar: SidebarPayload | null): { refs: string[]; upstreams: Record<string, string> } {
  const locals = (sidebar?.locals ?? []).filter((l) => l.upstream).sort((a, b) => b.tipTime - a.tipTime);
  return { refs: [...new Set(locals.map((l) => l.upstream!))], upstreams: Object.fromEntries(locals.map((l) => [l.fullName, l.upstream!])) };
}
