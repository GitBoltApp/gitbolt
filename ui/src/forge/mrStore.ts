import { create } from 'zustand';
import type { ForgeDiscussion } from '../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeMr } from '../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../api/gen/ForgeMrDetail';
import type { ForgeProject } from '../api/gen/ForgeProject';
import type { LocalBranch } from '../api/gen/LocalBranch';
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
  /** The remotes with a project on the target's host (4C: the push toast's Create link). */
  mapped: string[];
  /** The remote the repo's MRs/PRs target (the user's choice or the automatic pick), even when its project couldn't be loaded. */
  target: string | null;
  /** The target is the user's choice, not the automatic pick. */
  targetChosen: boolean;
  /** Why a remote's forge project couldn't be loaded (its row's hint), by remote name. */
  remoteErrors: Record<string, string>;
  /** Remote → its project owner's picture (`ForgeProject.ownerAvatarUrl`: a user's, an organization's or a group's): its remote icons show it (`RemoteIcon`). */
  ownerAvatars: Record<string, string>;
  /** The account's username (Approve's "You approved it"). */
  me: string | null;
  /** Remote-tracking ref (`refs/remotes/origin/dev`) → its MR/PR: the badges. */
  byRef: Record<string, ForgeMr>;
  /** Remote-tracking ref → a merged or closed MR/PR that badges nothing (its branch moved on, or its tip is unknown here): 4D's stack walk and after-merge flow read it (`branchMrs` in `stack/deps.ts`). */
  history: Record<string, ForgeMr>;
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
  kind: null, remote: null, project: null, mapped: [], target: null, targetChosen: false, remoteErrors: {}, ownerAvatars: {}, me: null, byRef: {}, history: {}, upstreams: {}, filter: 'all', list: null,
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

/** Load bookkeeping outside the store (it must not re-render anything): per MR (`<tab>:<n>`),
 * `loading` and `freshAt`; per tab, `writes` (the write epoch: GitBolt forge writes answered so
 * far) and `activatedAt` (the last full `activate` poll, which outlives the tab's pollers). */
export const forgeScratch = { loading: new Map<string, Promise<void>>(), freshAt: new Map<string, number>(), writes: new Map<string, number>(), activatedAt: new Map<string, number>(), /** Tabs whose next poll asks the forges again (an account was added or removed). */ recheck: new Set<string>() };

/** The tab's write epoch: a read that started under an older one may predate a write's answer. */
export const writeEpoch = (tabId: string): number => forgeScratch.writes.get(tabId) ?? 0;
/** A forge write was answered: reads already under way are dropped when they land. */
export const noteForgeWritten = (tabId: string): void => void forgeScratch.writes.set(tabId, writeEpoch(tabId) + 1);

/** A closed tab's forge state goes with it. */
export function dropForge(tabId: string): void {
  useForge.setState((s) => {
    if (!(tabId in s.byTab)) return s;
    const byTab = { ...s.byTab };
    delete byTab[tabId];
    return { byTab };
  });
  for (const m of [forgeScratch.loading, forgeScratch.freshAt]) for (const k of [...m.keys()]) if (k.startsWith(`${tabId}:`)) m.delete(k);
  forgeScratch.writes.delete(tabId);
  forgeScratch.activatedAt.delete(tabId);
  forgeScratch.recheck.delete(tabId);
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
 * the badges look up. 4D: first, the target branches of open MRs/PRs from local branches that
 * have no local branch (`forge`, the last poll's answer): a stack's merged bottom whose branch was
 * deleted after the merge is still found, within the core's lookup cap. */
export function upstreamRefsOf(sidebar: SidebarPayload | null, forge: Pick<TabForge, 'byRef' | 'upstreams' | 'remote' | 'project'> | null = null): { refs: string[]; upstreams: Record<string, string> } {
  // --- 4D T5: a branch pushed to its push target without an upstream is asked about too ---
  const asked = (l: LocalBranch): string | null => l.upstream ?? (l.pushTarget ? `refs/remotes/${l.pushTarget}` : null);
  const locals = (sidebar?.locals ?? []).flatMap((l) => { const ref = asked(l); return ref ? [{ l, ref }] : []; }).sort((a, b) => b.l.tipTime - a.l.tipTime);
  // --- end 4D T5 ---
  const targets: string[] = [];
  if (forge?.remote) {
    const names = new Set((sidebar?.locals ?? []).map((l) => l.name));
    for (const l of sidebar?.locals ?? []) {
      const up = forge.upstreams[l.fullName];
      const mr = (up ? forge.byRef[up] : undefined) ?? forge.byRef[`refs/remotes/${forge.remote}/${l.name}`];
      const t = mr && (mr.state === 'open' || mr.state === 'draft') ? mr.targetBranch : null;
      if (t && !names.has(t) && t !== forge.project?.defaultBranch) targets.push(`refs/remotes/${forge.remote}/${t}`);
    }
  }
  return { refs: [...new Set([...targets, ...locals.map((x) => x.ref)])], upstreams: Object.fromEntries(locals.map((x) => [x.l.fullName, x.ref])) };
}
