import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import { useAppState } from '../app/state';
import { useTabViews } from '../app/tabStores';
import type { RepoServices } from '../repo/services';
import { wipKey } from '../repo/wipLists';
import type { Eol } from '../api/gen/Eol';
import type { GbError } from '../api/gen/GbError';
import { registerUnsaved, type UnsavedWork } from '../diff/workingCopy';
import { chooseAction, confirmAction } from '../ui/ConfirmDialog';
import { ERROR_TOAST_MS, useToast } from '../ui/toast';
import { anyPicked, buildOutput, eolText, unpickedCount, type Picks, type Segment } from './model';
import { resolveFile } from './resolve';

/**
 * The merge tool's unsaved work, per (tab, worktree, path) (spec #2 §13.3: "Hand edits anywhere
 * are kept until the region they're in is rebuilt"), as 2B keeps a working copy's draft: it
 * outlives the editors (a hidden tab disposes them, another file replaces them) and a reload
 * (sessionStorage). The leave, tab-close and window-close guards ask about it (2B T11's
 * [Save] [Discard edits] [Cancel]).
 */

/** A region's place in the output, as character offsets. */
export interface Span { id: number; from: number; to: number }

export interface MergeDraft {
  tabId: string;
  repo: number;
  worktree: string;
  path: string;
  /** What a save sends as `base`: the file as the work started from it (changed since: Stale).
   * `null`: no file; `undefined`: take the next `conflictFile`'s (after Reload from disk). */
  base?: string | null;
  /** The conflict the work belongs to: a different one drops the work. */
  segments: Segment[];
  eol: Eol;
  picks: Picks;
  /** The output as it was last seen, with its regions; `null`: build it from `picks`. */
  text: string | null;
  spans: Span[] | null;
  edited: number[];
  /** Typed in (anywhere) since it was built. */
  typed: boolean;
  /** When it was last written (ms): the newest are the ones stored (N3). */
  at?: number;
}

const STORAGE = 'gitbolt.mergeDrafts';

function loadStored(): Record<string, MergeDraft> {
  try {
    const raw = sessionStorage.getItem(STORAGE);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? (v as Record<string, MergeDraft>) : {};
  } catch {
    return {};
  }
}

export const useMergeDrafts = create<{ drafts: Record<string, MergeDraft> }>(() => ({ drafts: loadStored() }));
/** At most this many drafts are stored, the newest (N3); the rest stay in memory only. */
export const STORED_DRAFTS = 20;
/** A draft bigger than this (its JSON, in UTF-16 units) stays in memory only. */
export const STORED_DRAFT_MAX = 1_000_000;

/** The drafts to store: the newest `STORED_DRAFTS`, each under `STORED_DRAFT_MAX`. */
export function storedDrafts(drafts: Record<string, MergeDraft>): Record<string, MergeDraft> {
  const kept = Object.entries(drafts)
    .map(([k, d]) => [k, d, JSON.stringify(d).length] as const)
    .filter(([, , n]) => n <= STORED_DRAFT_MAX)
    .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, STORED_DRAFTS);
  return Object.fromEntries(kept.map(([k, d]) => [k, d]));
}

useMergeDrafts.subscribe((s) => {
  try {
    sessionStorage.setItem(STORAGE, JSON.stringify(storedDrafts(s.drafts)));
  } catch {
    // Storage full or unavailable: the work stays in memory, and the old snapshot goes, so a
    // draft dropped since can't come back after a reload.
    try {
      sessionStorage.removeItem(STORAGE);
    } catch {
      /* unavailable */
    }
  }
});

export const draftKey = (tabId: string, worktree: string, path: string) => `${tabId}\n${worktree}\n${path}`;
export const getDraft = (key: string): MergeDraft | undefined => useMergeDrafts.getState().drafts[key];
export const putDraft = (key: string, d: MergeDraft) => useMergeDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...d, at: Date.now() } } }));
export const patchDraft = (key: string, p: Partial<MergeDraft>) =>
  useMergeDrafts.setState((s) => (s.drafts[key] ? { drafts: { ...s.drafts, [key]: { ...s.drafts[key], ...p, at: Date.now() } } } : s));
export const dropDraft = (key: string) =>
  useMergeDrafts.setState((s) => {
    if (!s.drafts[key]) return s;
    const { [key]: _gone, ...rest } = s.drafts;
    return { drafts: rest };
  });

/** Nothing to keep: no tick, no hand edit. */
export const isPristine = (d: Pick<MergeDraft, 'picks' | 'edited' | 'typed'>) => !d.typed && d.edited.length === 0 && !anyPicked(d.picks);

export const sameSegments = (a: Segment[], b: Segment[]) => JSON.stringify(a) === JSON.stringify(b);

/** A shown merge tool, by draft key. */
export interface LiveTool {
  tabId: string;
  /** Writes the editors' state into the draft (creating it when `force`). */
  flush(force?: boolean): void;
  /** Rebuilds the tool from the draft as it is now (re-reading the conflict). */
  reset(): void;
  /** The file was resolved: the tool keeps nothing more. */
  done(): void;
}
const live = new Map<string, LiveTool>();
export function registerLive(key: string, tool: LiveTool): () => void {
  live.set(key, tool);
  return () => { if (live.get(key) === tool) live.delete(key); };
}

/** A Conflicted row's Take current / Take incoming / Mark resolved while the merge tool holds
 * unsaved work on that file (2B's `SAVE_FIRST` for the working copy): they'd replace it. */
export const MERGE_SAVE_FIRST = 'Save the merge first';

/** Whether the merge tool holds unsaved work on (tab, worktree, path); a shown tool writes its
 * latest typing into the draft first. */
export function isMergeDirty(tabId: string, worktree: string, path: string): boolean {
  const key = draftKey(tabId, worktree, path);
  live.get(key)?.flush();
  const d = getDraft(key);
  return !!d && !isPristine(d);
}

/** `isMergeDirty`, as a hook (the row re-renders as the work comes and goes). */
export const useMergeDirty = (tabId: string, worktree: string, path: string): boolean =>
  useMergeDrafts((s) => {
    const d = s.drafts[draftKey(tabId, worktree, path)];
    return !!d && !isPristine(d);
  });

const lf = (t: string) => t.replace(/\r\n/g, '\n');
const toast = (m: string) => useToast.getState().show(m, { ms: ERROR_TOAST_MS });

/** Reload from disk: the output is rebuilt from the ticks (hand edits go), and the next
 * `conflictFile` gives the base. */
export function reloadDraft(key: string): void {
  patchDraft(key, { text: null, spans: null, edited: [], typed: false, base: undefined });
  live.get(key)?.reset();
}

const saving = new Set<string>();

/**
 * Saves the work and marks the file resolved (`ResolveFile` Text with the draft's base). It asks
 * first when a region has nothing picked and no hand edit. A Stale save asks [Reload from disk]
 * [Overwrite] (2B's `saveWorkingCopy`): Reload rebuilds from the file as it is now; Overwrite
 * re-reads only the base and sends the same text. True once resolved (the draft is gone then).
 */
export async function saveMerge(key: string, confirmed = false): Promise<boolean> {
  if (saving.has(key)) return false;
  live.get(key)?.flush(true);
  const d = getDraft(key);
  if (!d) return false;
  saving.add(key);
  const caught: { stale?: GbError } = {};
  try {
    const n = unpickedCount(d.segments, d.picks, new Set(d.edited));
    if (n > 0 && !confirmed) {
      const body = n === 1 ? '1 conflict has no lines picked. Save it empty?' : `${n} conflicts have no lines picked. Save them empty?`;
      if (!(await confirmAction({ title: 'Save with empty conflicts?', body, confirmLabel: 'Save' }))) return false;
    }
    // Monaco holds one line ending per model: an output nobody typed in goes out as built, so a
    // mixed-EOL file keeps each line's own (the 2D EOL ruling).
    const built = buildOutput(d.segments, d.picks, eolText(d.eol)).text;
    const text = d.text === null || lf(d.text) === lf(built) ? built : d.text;
    const ctx = { tabId: d.tabId, repoId: d.repo, worktree: d.worktree };
    const ok = await resolveFile(ctx, d.path, { kind: 'text', text }, d.base ?? undefined, (err) => {
      if (err.kind !== 'Stale') return false;
      caught.stale = err;
      return true;
    });
    if (ok) {
      live.get(key)?.done();
      dropDraft(key);
      return true;
    }
  } finally {
    saving.delete(key);
  }
  const err = caught.stale;
  if (!err) return false;
  const pick = await chooseAction({
    title: err.message,
    body: `${d.path} changed since the merge tool read it. Reload it from disk (your ticks stay while the conflict is the same; hand edits are lost), or overwrite it with your merge?`,
    choices: [{ id: 'reload', label: 'Reload from disk' }, { id: 'overwrite', label: 'Overwrite', danger: true }],
  });
  if (pick === 'reload') reloadDraft(key);
  if (pick !== 'overwrite') return false;
  let now;
  try {
    now = await api.conflictFile(d.repo, d.worktree, d.path);
  } catch (e) {
    toast(`Couldn't re-read ${d.path}: ${errorMessage(e)}`);
    return false;
  }
  if (!now) {
    toast(`${d.path} isn't conflicted any more`);
    live.get(key)?.reset();
    return false;
  }
  if (now.base === null) {
    // N6 (2B's `saveWorkingCopy`): no file to write over; the tool says so and offers a copy.
    toast(`${d.path} was deleted on disk`);
    patchDraft(key, { base: null });
    live.get(key)?.reset();
    return false;
  }
  patchDraft(key, { base: now.base });
  return saveMerge(key, true);
}

// --- N2: work whose file was resolved elsewhere (a row's Take, Mark resolved, `git add`, Abort),
// or whose tab is gone, is dropped, so no guard asks about it ---

/** Drops `key`'s draft; a shown tool re-reads its conflict (it says the file isn't conflicted). */
function forget(key: string): void {
  dropDraft(key);
  live.get(key)?.reset();
}

/** The drafts of tab `tabId` in `worktrees` whose file isn't conflicted in the WIP list held
 * now. A list that isn't held (an unwatched tab) can't tell, and keeps them. */
export function pruneResolved(tabId: string, services: Pick<RepoServices, 'wip'>, worktrees: ReadonlySet<string>): void {
  for (const [key, d] of Object.entries(useMergeDrafts.getState().drafts)) {
    if (d.tabId !== tabId || !worktrees.has(d.worktree)) continue;
    const list = services.wip.peek(wipKey(d.worktree, false));
    if (list && !list.files.some((f) => f.path === d.path && f.status === 'U')) forget(key);
  }
}

/** Drops the drafts of tabs the profile no longer has (closed, or their worktree removed). */
export function pruneClosedTabs(tabIds: ReadonlySet<string>): void {
  for (const [key, d] of Object.entries(useMergeDrafts.getState().drafts)) if (!tabIds.has(d.tabId)) forget(key);
}

const watchedWip = new WeakMap<RepoServices, () => void>();
const offViews = useTabViews.subscribe((s) => {
  for (const [tabId, v] of Object.entries(s.views)) {
    if (watchedWip.has(v.services)) continue;
    watchedWip.set(v.services, v.services.wip.subscribe((wts) => pruneResolved(tabId, v.services, wts)));
  }
});
const offTabs = useAppState.subscribe((s, prev) => {
  if (!s.loaded || s.profile.tabs === prev.profile.tabs) return;
  pruneClosedTabs(new Set(s.profile.tabs.map((t) => t.id)));
});
import.meta.hot?.dispose(() => { offViews(); offTabs(); });
// --- end N2 ---

const MERGE_BODY = 'Your merge of this file isn\'t saved yet.';
const workOf = (key: string, d: MergeDraft): UnsavedWork => ({
  path: d.path,
  body: MERGE_BODY,
  save: () => saveMerge(key),
  discard: () => {
    dropDraft(key);
    live.get(key)?.reset();
  },
});
const dirty = (d: MergeDraft | undefined): d is MergeDraft => !!d && !isPristine(d);

const off = registerUnsaved({
  shown: (tabId) => {
    for (const [key, t] of live) {
      if (t.tabId !== tabId) continue;
      t.flush();
      const d = getDraft(key);
      if (dirty(d)) return workOf(key, d);
    }
    return null;
  },
  any: (tabId) => {
    for (const t of live.values()) if (t.tabId === tabId) t.flush();
    const hit = Object.entries(useMergeDrafts.getState().drafts).find(([, d]) => d.tabId === tabId && dirty(d));
    return hit ? workOf(hit[0], hit[1]) : null;
  },
  anyAtAll: () => {
    for (const t of live.values()) t.flush();
    return Object.values(useMergeDrafts.getState().drafts).some(dirty);
  },
});
import.meta.hot?.dispose(off);
