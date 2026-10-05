import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorMessage, type ContentsRequest } from '../api/client';
import type { BlobSource } from '../api/gen/BlobSource';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { perf } from '../perf';
import { contentKey, filesKey, isMutableKey, type RepoServices } from './services';

/** Keyboard focus areas (spec §11.1). `sidebar` is registered by plan 1C. */
export type FocusZone = 'sidebar' | 'graph' | 'files' | 'diff';

export type Loadable<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; message: string };

export type Selection =
  | { kind: 'none' }
  | { kind: 'commit'; index: number; id: string }
  | { kind: 'wip'; index: number; worktree: string; name: string | null }
  | { kind: 'compare'; from: string; to: string }
  | { kind: 'compareWorktree'; from: string; worktree: string }
  /** Three or more rows (K27): their ids, top row (newest) first, and the id of the row a Shift
   * range starts from (spec #3 §4.3). No diff, no file lists. */
  | { kind: 'multi'; ids: readonly string[]; anchor: string };

/** What the center panel shows (spec §10.1). `key` is stable for the same file in the same diff. */
export interface DiffTarget {
  key: string;
  path: string;
  oldPath: string | null;
  status: string;
  old: BlobSource;
  new: BlobSource;
  /** `file` = File View (the whole file, read-only); `diff` = Diff View. */
  view: 'diff' | 'file';
}

export interface FileSection { title: string | null; spec: DiffSpec; list: Loadable<FileListPayload> }

/** What the right panel shows: one selection with everything loaded for it (feedback F12). */
export interface PanelContent {
  selection: Exclude<Selection, { kind: 'none' }>;
  parent: number;
  details: Loadable<CommitDetailsPayload>;
  message: Loadable<CommitMessage>;
  sections: FileSection[];
}
/**
 * The selected rows of a compare or a multi-selection (spec §9.4, K27), as row indexes. Empty
 * for a single selection (its row is the selection's `index`). All of them show as selected.
 */
export interface Picks {
  /** In the order they were picked: a click, then each Ctrl+click; a Shift range from its anchor
   * out. A compare's FROM is the first, its TO the second. */
  rows: readonly number[];
  /** Where a Shift+click range starts: the row plain- or Ctrl+clicked last. `null`: not in the
   * loaded graph. */
  anchor: number | null;
  /** The keyboard's position: the row clicked last. `null`: not in the loaded graph. */
  cursor: number | null;
}

/** Row-click modifiers: `ctrl` toggles the row in or out, `shift` selects a range (K27). */
export interface SelectMods { ctrl?: boolean; shift?: boolean }

/** A selection by row id, with the merge parent shown and the open file (`snapshotSelection`):
 * what a center view that drives the details panel puts back when it closes (the rebase editor). */
export interface SelectionSnapshot {
  rows: readonly string[];
  anchor: string | null;
  cursor: string | null;
  parent: number;
  diff: DiffTarget | null;
}

export interface RepoViewState {
  repo: number;
  repoPath: string;
  services: RepoServices;
  graph: GraphPayload;
  indexById: Map<string, number>;
  selection: Selection;
  /** A compare's or multi-selection's rows; empty for a single selection. */
  picks: Picks;
  parent: number;
  /** The selected commit's header (§9.1); `idle` unless a single commit is selected. */
  details: Loadable<CommitDetailsPayload>;
  /**
   * The selected commit's full message (§9.2), from `services.messages` (the `commitMessage`
   * cache the graph tooltip shares): `CommitDetailsPayload` carries no message. `idle` unless a
   * single commit is selected.
   */
  message: Loadable<CommitMessage>;
  sections: FileSection[];
  /**
   * What the right panel shows (feedback F12, stale-while-loading): the selection's content
   * once its details, message (a single commit) and every file list have settled (loaded or
   * failed), else the previous selection's, unchanged, so the panel swaps in one render with no
   * empty or partial frame. `null` while nothing is selected, and until the first selection's
   * content has arrived.
   */
  panel: PanelContent | null;
  /** The selection's content is still loading: `panel` shows an earlier one. */
  panelPending: boolean;
  diff: DiffTarget | null;
  focus: FocusZone;
  /**
   * Bumped by every focus request (`setFocus`, and the actions that move focus). `useFocusZone`
   * re-focuses its element on each bump, even when `focus` already names its zone: `focus`
   * follows DOM focus-in only, so it can be stale after focus moved outside every zone.
   */
  focusRequest: number;
  /**
   * The file list (its `filesKey`) the keyboard cursor was last put in. With no diff open, only
   * that list shows its cursor row, so a WIP's two lists never both show one (fix round 1).
   */
  fileListCursor: string | null;
  setFileListCursor(key: string): void;
  /**
   * Plan 1C Find (Ctrl+F, spec §8.7): the commit ids that match, or `null` for no search. While
   * set, the graph dims every other row's text at the row-dim mechanism's `'filter'` level
   * (rowDim.ts). By id, so a refresh that moves the rows keeps dimming the same commits.
   */
  filterKeep: ReadonlySet<string> | null;
  setFilterKeep(keep: ReadonlySet<string> | null): void;
  setGraph(graph: GraphPayload): void;
  /**
   * The tab's watch is up (`true`, once `watchRepo` returned) or stopped (K44): while it's up,
   * the WIP rows' lists are held in memory (`services.wip`) and loaded ahead, so selecting a WIP
   * row renders them at once. Stopped, they're dropped and read on selection again.
   */
  setWatched(on: boolean): void;
  /**
   * Spec §9.4, K27. A plain click selects the row alone. A Ctrl+click adds the row to the
   * selection, or removes it if it's selected (never the only one). Shift+click selects the
   * rows from the anchor to this one; with Ctrl too, it adds them. Two rows are a compare, the
   * first picked as FROM; three or more, a multi-selection.
   */
  selectRow(index: number, mods?: SelectMods): void;
  selectCommitById(id: string): boolean;
  /** The selection as it is now, by row id (UX R2.2). */
  snapshotSelection(): SelectionSnapshot;
  /** Selects `snap`'s rows again, those still in the graph; none left, nothing is selected. With
   * every row back, its merge parent and open file come back too. */
  restoreSelection(snap: SelectionSnapshot): void;
  /** Compares commit `from` (FROM) with `to` (TO), with the anchor and the keyboard on `from`
   * ("Compare with HEAD"). False when either isn't in the loaded graph. */
  compareCommits(from: string, to: string): boolean;
  /** Reverses a two-commit compare. An open diff moves to the same file in the reversed list,
   * or closes. */
  swapCompare(): void;
  /** Leaves a compare or multi-selection for the anchor row alone. */
  exitCompare(): void;
  compareWithWorktree(from: string, worktree: string): void;
  setParent(parent: number): void;
  /** Opens `target` and prefetches `neighbours`' contents (object-addressed ones only). */
  openFile(target: DiffTarget, neighbours?: DiffTarget[]): void;
  /** Opens the first file of the first non-empty section. `order` gives a section's files as
   * its list displays them (Tree mode, Sort by status); the default is the backend's order. */
  openFirstFile(order?: FileOrder): void;
  setView(view: 'diff' | 'file'): void;
  closeDiff(): void;
  /** Closes the diff, focusing `zone` instead of the graph (the file list's toggle, H5b). */
  closeDiffTo(zone: FocusZone): void;
  setFocus(zone: FocusZone): void;
  /** Spec #2 §7.5: asked before the open file is left (`openFile`, `closeDiff`, `closeDiffTo`,
   * `selectRow`). It returns `true` when it took over: it calls `go` itself, or never. */
  setLeaveGuard(guard: ((go: () => void) => boolean) | null): void;
  /** Runs `go` once leaving the open file is settled: at once, or after the leave guard's prompt
   * (never, if it's cancelled). For what opens a file another way: spec #5's Back/Forward and
   * Markdown links ask once, not once per step. */
  leaveThen(go: () => void): void;
}

export type RepoViewStore = StoreApi<RepoViewState>;

/** A section's files in display order, as diff targets. */
export type FileOrder = (files: FileChange[], spec: DiffSpec) => DiffTarget[];

const backendOrder: FileOrder = (files, spec) => files.map((f) => targetFor(f, spec));

/** A keyed, cached source: a `Loader` or the `CommitMessageCache`. */
interface Source<T> { peek(key: string): T | undefined; get(key: string): Promise<T> }

const NO_PICKS: Picks = { rows: [], anchor: null, cursor: null };
const IDLE = { status: 'idle' } as const;
const indexGraph = (g: GraphPayload) => new Map(g.rows.map((r, i) => [r.id, i] as const));

export function targetFor(f: FileChange, spec: DiffSpec): DiffTarget {
  return { key: `${filesKey(spec)}|${f.path}`, path: f.path, oldPath: f.oldPath, status: f.status, old: f.old, new: f.new, view: 'diff' };
}

/** An unchanged file from "View all files": File View of `path` at `commit` (spec §9.3). */
export function fileViewTarget(path: string, commit: string, spec: DiffSpec): DiffTarget {
  return { key: `${filesKey(spec)}|all|${path}`, path, oldPath: null, status: '', old: { kind: 'absent' }, new: { kind: 'atCommit', commit }, view: 'file' };
}

/** UX G.2: a tracked, unchanged file from the WIP row's "View all files": File View of the
 * working-tree file itself, so it's editable (`isEditableTarget`). */
export function worktreeViewTarget(path: string, worktree: string, spec: DiffSpec): DiffTarget {
  return { key: `${filesKey(spec)}|all|${path}`, path, oldPath: null, status: '', old: { kind: 'absent' }, new: { kind: 'worktree', worktree }, view: 'file' };
}

export const contentsRequest =(t: DiffTarget, force = false): ContentsRequest => ({ path: t.path, old: t.old, new: t.new, force });

export function selectedIndex(s: RepoViewState): number {
  switch (s.selection.kind) {
    case 'commit':
    case 'wip':
      return s.selection.index;
    case 'compare':
    case 'compareWorktree':
    case 'multi':
      return s.picks.cursor ?? -1;
    default:
      return -1;
  }
}

/** One selected commit (spec #3 §4.3): what the selection's menu and 3C's editor preset use. */
export interface CommitRef { oid: string; summary: string; merge: boolean }

/** The selected commits in graph order (newest first): a single commit, a compare's two, a
 * multi-selection's. WIP rows and stash nodes are left out; empty when no commit is selected. */
export function selectedCommits(s: Pick<RepoViewState, 'selection' | 'picks' | 'graph'>): CommitRef[] {
  const k = s.selection.kind;
  const rows = k === 'commit' ? [s.selection.index] : k === 'compare' || k === 'compareWorktree' || k === 'multi' ? s.picks.rows : [];
  return [...rows]
    .sort((a, b) => a - b)
    .map((i) => s.graph.rows[i])
    .filter((r) => r !== undefined && (r.kind === 'commit' || r.kind === 'merge'))
    .map((r) => ({ oid: r.id, summary: r.summary, merge: r.parents.length > 1 }));
}

/** Whether commit `id`'s row is part of a selection holding two or more commits: a right-click
 * there opens the selection's menu (spec #3 §4.3). */
export function inCommitSelection(s: Pick<RepoViewState, 'selection' | 'picks' | 'graph' | 'indexById'>, id: string): boolean {
  const i = s.indexById.get(id);
  const k = s.selection.kind;
  if (i === undefined || (k !== 'compare' && k !== 'compareWorktree' && k !== 'multi') || !s.picks.rows.includes(i)) return false;
  return selectedCommits(s).length >= 2;
}

/** The open worktree (the tab's own, dirty or not), spelled as its WIP row's `worktreePath`:
 * what "Compare with working tree" targets, never just the first WIP row (K37). */
export function openWorktree(s: Pick<RepoViewState, 'graph' | 'repoPath'>): string {
  return s.graph.openWorktree ?? s.repoPath;
}

/** The selected rows, in pick order: a single selection's one row, or the picks (K27). */
function pickedRows(s: RepoViewState): readonly number[] {
  if (s.selection.kind === 'commit' || s.selection.kind === 'wip') return [s.selection.index];
  return s.picks.rows;
}

/** Where a Shift range starts (K27): a single selection's row, else the picks' anchor. */
function anchorOf(s: RepoViewState): number | null {
  if (s.selection.kind === 'commit' || s.selection.kind === 'wip') return s.selection.index;
  return s.picks.anchor ?? s.picks.cursor;
}

/** Rows `from` to `to`, inclusive, from `from` out. */
const range = (from: number, to: number) => Array.from({ length: Math.abs(to - from) + 1 }, (_, k) => from + (to >= from ? k : -k));

/** The file lists a selection shows, in order. */
function sectionSpecs(selection: Selection, parent: number): { title: string | null; spec: DiffSpec }[] {
  switch (selection.kind) {
    case 'commit':
      return [{ title: null, spec: { kind: 'commit', id: selection.id, parent } }];
    case 'wip':
      return [
        { title: 'Unstaged', spec: { kind: 'wip', worktree: selection.worktree, staged: false } },
        { title: 'Staged', spec: { kind: 'wip', worktree: selection.worktree, staged: true } },
      ];
    case 'compare':
      return [{ title: null, spec: { kind: 'compare', from: selection.from, to: selection.to } }];
    case 'compareWorktree':
      return [{ title: null, spec: { kind: 'worktree', from: selection.from, worktree: selection.worktree } }];
    default:
      return [];
  }
}

const settled = (l: Loadable<unknown>) => l.status === 'ready' || l.status === 'error';
const settledFor = (l: Loadable<{ id: string }>, id: string) => l.status === 'error' || (l.status === 'ready' && l.data.id === id);

/** The panel for state `s` (whose `panel` is the one shown so far): `s`'s own content once all
 * of it has settled, else the one shown so far. */
function panelFor(s: RepoViewState): Pick<RepoViewState, 'panel' | 'panelPending'> {
  const { selection, parent, details, message, sections } = s;
  if (selection.kind === 'none') return { panel: null, panelPending: false };
  const want = sectionSpecs(selection, parent).map((x) => filesKey(x.spec));
  const complete = sections.length === want.length
    && sections.every((x, i) => filesKey(x.spec) === want[i] && settled(x.list))
    && (selection.kind !== 'commit' || (settledFor(details, selection.id) && settledFor(message, selection.id)));
  if (!complete) return { panel: s.panel, panelPending: true };
  const p = s.panel;
  if (p && p.selection === selection && p.parent === parent && p.details === details && p.message === message && p.sections === sections) return { panel: p, panelPending: false };
  return { panel: { selection, parent, details, message, sections }, panelPending: false };
}

/** Where a section's list comes from: WIP lists are held apart (K44). */
const sourceFor = (services: RepoServices, spec: DiffSpec): Source<FileListPayload> => (spec.kind === 'wip' ? services.wip : services.files);

/** The WIP rows' worktrees, the main worktree's first (K44 loads them ahead). */
function wipWorktrees(g: GraphPayload): string[] {
  const rows = g.rows.flatMap((r) => (r.kind === 'wip' && r.wip ? [r.wip] : []));
  return [...rows.filter((w) => w.worktreeName === null), ...rows.filter((w) => w.worktreeName !== null)].map((w) => w.worktreePath);
}

export function createRepoViewStore(repo: number, repoPath: string, graph: GraphPayload, services: RepoServices): RepoViewStore {
  // Bumped on every selection change; results for an older selection are dropped.
  let seq = 0;
  // Bumped by every section load: a superseded one (an older refresh) is dropped too.
  let sectionsSeq = 0;
  let leaveGuard: ((go: () => void) => boolean) | null = null;
  const guarded = <A extends unknown[]>(fn: (...a: A) => void, skip?: (...a: A) => boolean) => (...a: A): void => {
    if (!skip?.(...a) && leaveGuard?.(() => fn(...a))) return;
    fn(...a);
  };

  return createStore<RepoViewState>((rawSet, get) => {
    /** Every update also settles what the panel shows (`panelFor`), in the same update. */
    const set = (patch: Partial<RepoViewState> | ((s: RepoViewState) => Partial<RepoViewState>)) =>
      rawSet((st) => {
        const p = typeof patch === 'function' ? patch(st) : patch;
        return { ...p, ...panelFor({ ...st, ...p }) };
      });

    /** `quiet`: no `loading` state first (a refresh keeps what's shown until its result). */
    function load<T>(source: Source<T>, key: string, apply: (l: Loadable<T>) => void, mySeq: number, quiet = false) {
      const hit = source.peek(key);
      if (hit !== undefined) {
        apply({ status: 'ready', data: hit });
        return;
      }
      if (!quiet) apply({ status: 'loading' });
      source.get(key).then(
        (data) => { if (mySeq === seq) apply({ status: 'ready', data }); },
        (e: unknown) => { if (mySeq === seq) apply({ status: 'error', message: errorMessage(e) }); },
      );
    }

    /** Loads the selection's file lists; `refresh` (the selected WIP's lists changed, K44)
     * keeps the lists shown until the new ones arrive. */
    function loadSections(specs: { title: string | null; spec: DiffSpec }[], mySeq: number, refresh = false) {
      const myLoad = ++sectionsSeq;
      if (!refresh) set({ sections: specs.map((s) => ({ ...s, list: { status: 'loading' } })) });
      specs.forEach((s, i) => load(sourceFor(services, s.spec), filesKey(s.spec), (list) => {
        if (mySeq === seq && myLoad === sectionsSeq) set((st) => ({ sections: st.sections.map((sec, j) => (j === i ? { ...sec, list } : sec)) }));
      }, mySeq, refresh));
    }

    // A watched worktree's WIP lists changed (K44): load them again ahead, and refresh the
    // panel if it's that WIP row's.
    services.wip.subscribe((worktrees) => {
      services.wip.prefetch([...worktrees]);
      const { selection } = get();
      if (selection.kind === 'wip' && worktrees.has(selection.worktree)) loadSections(sectionSpecs(selection, 0), seq, true);
    });

    function loadCommit(id: string, mySeq: number) {
      load(services.details, id, (details) => set({ details }), mySeq);
      load(services.messages, id, (message) => set({ message }), mySeq);
    }

    /** Leaves every selection: late results for the old one are dropped. */
    function clearSelection(extra: Partial<RepoViewState> = {}) {
      ++seq;
      set({ selection: { kind: 'none' }, picks: NO_PICKS, details: IDLE, message: IDLE, sections: [], diff: null, ...extra });
    }

    function requestFocus(zone: FocusZone, extra: Partial<RepoViewState> = {}) {
      set((st) => ({ ...extra, focus: zone, focusRequest: st.focusRequest + 1 }));
    }

    function selectCommit(index: number) {
      const rows = get().graph.rows;
      const row = rows[index];
      const mySeq = ++seq;
      perf.start('details');
      const selection: Selection = { kind: 'commit', index, id: row.id };
      set({ selection, picks: NO_PICKS, parent: 0, diff: null, details: IDLE, message: IDLE });
      loadCommit(row.id, mySeq);
      loadSections(sectionSpecs(selection, 0), mySeq);
      // The signature check starts with the details, not after them (the badge asks for the same
      // load); an unsigned commit answers without running anything.
      services.signature.get(row.id).catch(() => {});
      askPeople(row.id, true);
      // The neighbours' details, file lists and messages: Up/Down then swaps the panel at once.
      // Two away for the details, signatures and avatars (cheap); one for the rest.
      const commitsAt = (offsets: number[]) => offsets.map((d) => index + d).filter((i) => i >= 0 && i < rows.length && rows[i].kind !== 'wip').map((i) => rows[i].id);
      const near = commitsAt([-1, 1]);
      const near2 = commitsAt([-1, 1, -2, 2]);
      services.details.prefetch(near2);
      services.signature.prefetch(near2);
      for (const id of near2) askPeople(id, false);
      services.files.prefetch(near.map((id) => filesKey({ kind: 'commit', id, parent: 0 })));
      for (const id of near) if (!services.messages.peek(id)) services.messages.get(id).catch(() => {});
    }

    /** Asks for the avatars of commit `id`'s people once its details are in (a prefetched
     * neighbour's too): the author, a different committer and the co-authors. The graph draws
     * only authors, so the others would otherwise be asked for only when the panel renders them. */
    function askPeople(id: string, selected: boolean) {
      const ask = (d: CommitDetailsPayload | undefined) => {
        // Partial payloads (test doubles) ask for whatever they carry.
        if (!d) return;
        // Each email once, with its first person's name (the backend's last look: by name).
        const people = new Map<string, string | undefined>();
        for (const p of [d.author, d.committer, ...(d.coAuthors ?? [])]) {
          if (p?.email && !people.has(p.email)) people.set(p.email, p.name);
        }
        for (const [email, name] of people) {
          if (selected) services.avatars.request(email, name);
          else services.avatars.prefetchOne(email, name);
        }
      };
      const hit = services.details.peek(id);
      if (hit) ask(hit);
      else services.details.get(id, 'prefetch').then(ask, () => {});
    }

    /** Selects row `index` alone. */
    function selectOne(index: number) {
      const row = get().graph.rows[index];
      if (row.kind === 'wip' && row.wip) {
        const w = row.wip;
        const mySeq = ++seq;
        const wip: Selection = { kind: 'wip', index, worktree: w.worktreePath, name: w.worktreeName };
        set({ selection: wip, picks: NO_PICKS, diff: null, details: IDLE, message: IDLE });
        loadSections(sectionSpecs(wip, 0), mySeq);
      } else {
        selectCommit(index);
      }
    }

    /** Selects `picks` (all shown as selected) and compares `selection`'s endpoints. Like any
     * selection change, it closes the open diff, except `reopen`: the diff open before a swap.
     * It stays open while the reversed list loads, then moves to the same file in that list (a
     * rename under its old path), or closes. */
    function startCompare(selection: Extract<Selection, { kind: 'compare' | 'compareWorktree' }>, picks: Picks, reopen: DiffTarget | null = null) {
      const mySeq = ++seq;
      set({ selection, picks, diff: reopen, details: IDLE, message: IDLE });
      const specs = sectionSpecs(selection, 0);
      loadSections(specs, mySeq);
      if (!reopen) return;
      const spec = specs[0].spec;
      const stillOpen = () => mySeq === seq && get().diff === reopen;
      services.files.get(filesKey(spec)).then((list) => {
        if (!stillOpen()) return;
        const i = list.files.findIndex((f) => f.path === reopen.path || (reopen.oldPath !== null && f.path === reopen.oldPath && f.oldPath === reopen.path));
        if (i < 0) set({ diff: null });
        else get().openFile({ ...targetFor(list.files[i], spec), view: reopen.view }, list.files.slice(i + 1, i + 2).map((f) => targetFor(f, spec)));
      }, () => { if (stillOpen()) set({ diff: null }); });
    }

    /**
     * Selects `rows` (pick order) with `anchor` and `cursor` (K27). One row is a single
     * selection. Two are a compare, the first as FROM: a commit with a WIP row compares it with
     * that working tree; two WIP rows can't be compared, so the cursor's is selected alone.
     * Three or more are a multi-selection, with nothing to load.
     */
    function pick(rows: readonly number[], anchor: number | null, cursor: number) {
      const g = get().graph.rows;
      if (rows.length === 1) return selectOne(rows[0]);
      const picks: Picks = { rows, anchor, cursor };
      if (rows.length === 2) {
        const [from, to] = [g[rows[0]], g[rows[1]]];
        if (from.kind !== 'wip' && to.kind !== 'wip') startCompare({ kind: 'compare', from: from.id, to: to.id }, picks);
        else if (from.kind !== 'wip' || to.kind !== 'wip') {
          const [commit, wip] = from.kind === 'wip' ? [to, from] : [from, to];
          startCompare({ kind: 'compareWorktree', from: commit.id, worktree: wip.wip!.worktreePath }, picks);
        } else selectOne(cursor);
        return;
      }
      ++seq;
      const ids = [...rows].sort((a, b) => a - b).map((i) => g[i].id);
      const anchorId = g[anchor ?? cursor]?.id ?? ids[0];
      set({ selection: { kind: 'multi', ids, anchor: anchorId }, picks, parent: 0, diff: null, details: IDLE, message: IDLE, sections: [] });
    }

    const state: RepoViewState = {
      repo,
      repoPath,
      services,
      graph,
      indexById: indexGraph(graph),
      selection: { kind: 'none' },
      picks: NO_PICKS,
      parent: 0,
      details: IDLE,
      message: IDLE,
      sections: [],
      panel: null,
      panelPending: false,
      diff: null,
      focus: 'graph',
      focusRequest: 0,
      fileListCursor: null,
      filterKeep: null,

      setFileListCursor(key) {
        if (get().fileListCursor !== key) set({ fileListCursor: key });
      },

      setFilterKeep(keep) {
        if (get().filterKeep !== keep) rawSet({ filterKeep: keep });
      },

      setGraph(next) {
        const prev = get();
        if (next === prev.graph) return;
        const indexById = indexGraph(next);
        const remap = (i: number | null) => (i === null ? null : indexById.get(prev.graph.rows[i]?.id ?? '') ?? null);
        let selection: Selection = prev.selection;
        if (selection.kind === 'commit') {
          const i = indexById.get(selection.id);
          selection = i === undefined ? { kind: 'none' } : { ...selection, index: i };
        } else if (selection.kind === 'wip') {
          const worktree = selection.worktree;
          const i = next.rows.findIndex((r) => r.wip?.worktreePath === worktree);
          selection = i < 0 ? { kind: 'none' } : { ...selection, index: i };
        } else if (selection.kind === 'multi') {
          // The rows still there, by commit id, in their new order.
          const ids = selection.ids.filter((id) => indexById.has(id)).sort((a, b) => indexById.get(a)! - indexById.get(b)!);
          selection = ids.length === 0 ? { kind: 'none' } : { kind: 'multi', ids, anchor: ids.includes(selection.anchor) ? selection.anchor : ids[0] };
        }
        const p = prev.picks;
        const picks = p === NO_PICKS ? NO_PICKS : { rows: p.rows.map(remap).filter((i) => i !== null), anchor: remap(p.anchor), cursor: remap(p.cursor) };
        // The selected commit or worktree is gone: clear what was shown for it.
        if (selection.kind === 'none' && prev.selection.kind !== 'none') return clearSelection({ graph: next, indexById });
        set({ graph: next, indexById, selection, picks });
        services.wip.prefetch(wipWorktrees(next));
        // Picked rows gone (K27): select those left anew, so two left are a compare and one a
        // single selection. The anchor and cursor, if gone, move to the row picked last.
        if (picks.rows.length < p.rows.length) {
          const last = picks.rows[picks.rows.length - 1];
          if (last === undefined) clearSelection();
          else pick(picks.rows, picks.anchor ?? last, picks.cursor ?? last);
        }
      },

      setWatched(on) {
        services.wip.setWatched(on);
        if (on) services.wip.prefetch(wipWorktrees(get().graph));
      },

      selectRow(index, mods = {}) {
        const s = get();
        if (!s.graph.rows[index]) return;
        const current = pickedRows(s);
        if (mods.shift) {
          const anchor = anchorOf(s);
          if (anchor === null) return selectOne(index);
          const span = range(anchor, index);
          // With Ctrl, the range joins what's selected (after it, in range order).
          const have = new Set(current);
          pick(mods.ctrl ? [...current, ...span.filter((i) => !have.has(i))] : span, anchor, index);
        } else if (mods.ctrl && current.includes(index)) {
          // Remove it, never the only one. The anchor and cursor, if it was either, move to the
          // row picked last of those left.
          if (current.length === 1) return;
          const rows = current.filter((i) => i !== index);
          const last = rows[rows.length - 1];
          const anchor = anchorOf(s);
          pick(rows, anchor === index ? last : anchor, s.picks.cursor === index || s.picks.cursor === null ? last : s.picks.cursor);
        } else if (mods.ctrl && current.length > 0) {
          pick([...current, index], index, index);
        } else {
          selectOne(index);
        }
      },

      selectCommitById(id) {
        const i = get().indexById.get(id);
        if (i === undefined) return false;
        get().selectRow(i);
        return true;
      },

      snapshotSelection() {
        const s = get();
        const id = (i: number | null) => (i === null ? null : s.graph.rows[i]?.id ?? null);
        const cursor = s.selection.kind === 'commit' || s.selection.kind === 'wip' ? s.selection.index : s.picks.cursor;
        return { rows: pickedRows(s).map((i) => s.graph.rows[i].id), anchor: id(anchorOf(s)), cursor: id(cursor), parent: s.parent, diff: s.diff };
      },

      restoreSelection(snap) {
        const { indexById } = get();
        const at = (id: string | null) => (id === null ? undefined : indexById.get(id));
        const rows = snap.rows.map((id) => indexById.get(id)).filter((i) => i !== undefined);
        // Rows rewritten later (a rebase's refresh after its editor closed) go then: `setGraph`
        // re-resolves the selection by id.
        if (rows.length === 0) return clearSelection();
        const last = rows[rows.length - 1];
        pick(rows, at(snap.anchor) ?? last, at(snap.cursor) ?? last);
        // Whatever file is open now (one opened from the details panel meanwhile) closes; the
        // snapshot's own comes back only with every row.
        const complete = rows.length === snap.rows.length;
        if (complete && snap.parent > 0) get().setParent(snap.parent);
        set({ diff: complete ? snap.diff : null });
      },

      compareCommits(from, to) {
        const { indexById } = get();
        const i = indexById.get(from), j = indexById.get(to);
        if (i === undefined || j === undefined) return false;
        pick([i, j], i, i);
        return true;
      },

      swapCompare() {
        const { selection, picks, diff } = get();
        if (selection.kind !== 'compare') return;
        startCompare({ kind: 'compare', from: selection.to, to: selection.from }, { ...picks, rows: [...picks.rows].reverse() }, diff);
      },

      exitCompare() {
        const { selection, picks } = get();
        if (selection.kind !== 'compare' && selection.kind !== 'compareWorktree' && selection.kind !== 'multi') return;
        const target = picks.anchor ?? picks.rows[picks.rows.length - 1] ?? null;
        // Both clear the picks, in the same update as the new selection.
        if (target !== null) selectOne(target);
        else clearSelection();
      },

      compareWithWorktree(from, worktree) {
        const { indexById, graph: g } = get();
        const commitRow = indexById.get(from) ?? null;
        const wipRow = g.rows.findIndex((r) => r.wip?.worktreePath === worktree);
        const rows = [commitRow, wipRow < 0 ? null : wipRow].filter((i) => i !== null);
        startCompare({ kind: 'compareWorktree', from, worktree }, { rows, anchor: commitRow, cursor: commitRow });
      },

      setParent(parent) {
        const { selection } = get();
        if (selection.kind !== 'commit') return;
        const mySeq = ++seq;
        set({ parent, diff: null });
        // The new seq drops any pending details/message callback, so re-attach them: these
        // loads dedupe to the in-flight request or hit the cache.
        loadCommit(selection.id, mySeq);
        loadSections(sectionSpecs(selection, parent), mySeq);
      },

      openFile(target, neighbours = []) {
        perf.start('diff');
        set({ diff: target });
        // Worktree-side contents are never cached (plan 1B deviation 9): prefetching one would
        // be a read whose result is thrown away.
        services.contents.prefetch(neighbours.map((n) => contentKey(contentsRequest(n))).filter((k) => !isMutableKey(k)));
      },

      /** Opens the first file of the first non-empty section (a WIP row may have only staged
       * changes). Synchronous when the lists are already loaded. */
      openFirstFile(order = backendOrder) {
        const mySeq = seq;
        const step = (i: number): void => {
          // The sections as they are now (same selection: `mySeq`): a list may have arrived, or
          // been refreshed (K44), since the previous step.
          const section = get().sections[i];
          if (mySeq !== seq || !section) return;
          const use = (list: FileListPayload) => {
            if (mySeq !== seq) return;
            if (list.files.length === 0) return step(i + 1);
            const targets = order(list.files, section.spec);
            get().openFile(targets[0], targets.slice(1, 2));
            requestFocus('files');
          };
          if (section.list.status === 'ready') use(section.list.data);
          else sourceFor(services, section.spec).get(filesKey(section.spec)).then(use, () => step(i + 1));
        };
        step(0);
      },

      setView(view) {
        const diff = get().diff;
        if (diff) set({ diff: { ...diff, view } });
      },

      closeDiff() {
        requestFocus('graph', { diff: null });
      },

      closeDiffTo(zone) {
        requestFocus(zone, { diff: null });
      },

      setFocus(zone) {
        requestFocus(zone);
      },

      setLeaveGuard(guard) {
        leaveGuard = guard;
      },

      leaveThen(go) {
        if (!leaveGuard?.(go)) go();
      },
    };
    // Spec #2 §7.5: leaving the open file asks the guard first.
    return {
      ...state,
      // Opening the file already open (a re-click) leaves nothing behind.
      openFile: guarded(state.openFile, (t) => t.key === get().diff?.key && t.view === get().diff?.view),
      setView: guarded(state.setView, (v) => v === get().diff?.view),
      closeDiff: guarded(state.closeDiff),
      closeDiffTo: guarded(state.closeDiffTo),
      selectRow: guarded(state.selectRow),
    };
  });
}

export const RepoViewContext = createContext<RepoViewStore | null>(null);

export function useRepoViewStore(): RepoViewStore {
  const store = useContext(RepoViewContext);
  if (!store) throw new Error('useRepoView must be used inside <RepoView>');
  return store;
}

export function useRepoView<T>(selector: (s: RepoViewState) => T): T {
  return useStore(useRepoViewStore(), selector);
}
