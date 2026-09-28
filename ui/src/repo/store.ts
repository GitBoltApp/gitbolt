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
  | { kind: 'compareWorktree'; from: string; worktree: string };

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
  marks: CompareMarks;
  parent: number;
  details: Loadable<CommitDetailsPayload>;
  message: Loadable<CommitMessage>;
  sections: FileSection[];
}
/** Compare endpoints as row indexes: `a` is the first Ctrl+click, `b` the second (spec §9.4). */
export interface CompareMarks { a: number | null; b: number | null }

export interface RepoViewState {
  repo: number;
  repoPath: string;
  services: RepoServices;
  graph: GraphPayload;
  indexById: Map<string, number>;
  selection: Selection;
  marks: CompareMarks;
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
  setGraph(graph: GraphPayload): void;
  selectRow(index: number, mods?: { ctrl?: boolean }): void;
  selectCommitById(id: string): boolean;
  /** Reverses a compare. An open diff moves to the same file in the reversed list, or closes. */
  swapCompare(): void;
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
}

export type RepoViewStore = StoreApi<RepoViewState>;

/** A section's files in display order, as diff targets. */
export type FileOrder = (files: FileChange[], spec: DiffSpec) => DiffTarget[];

const backendOrder: FileOrder = (files, spec) => files.map((f) => targetFor(f, spec));

/** A keyed, cached source: a `Loader` or the `CommitMessageCache`. */
interface Source<T> { peek(key: string): T | undefined; get(key: string): Promise<T> }

const NO_MARKS: CompareMarks = { a: null, b: null };
const IDLE = { status: 'idle' } as const;
const indexGraph = (g: GraphPayload) => new Map(g.rows.map((r, i) => [r.id, i] as const));

export function targetFor(f: FileChange, spec: DiffSpec): DiffTarget {
  return { key: `${filesKey(spec)}|${f.path}`, path: f.path, oldPath: f.oldPath, status: f.status, old: f.old, new: f.new, view: 'diff' };
}

/** An unchanged file from "View all files": File View of `path` at `commit` (spec §9.3). */
export function fileViewTarget(path: string, commit: string, spec: DiffSpec): DiffTarget {
  return { key: `${filesKey(spec)}|all|${path}`, path, oldPath: null, status: '', old: { kind: 'absent' }, new: { kind: 'atCommit', commit }, view: 'file' };
}

export const contentsRequest = (t: DiffTarget, force = false): ContentsRequest => ({ path: t.path, old: t.old, new: t.new, force });

export function selectedIndex(s: RepoViewState): number {
  switch (s.selection.kind) {
    case 'commit':
    case 'wip':
      return s.selection.index;
    case 'compare':
      return s.marks.b ?? -1;
    case 'compareWorktree':
      return s.marks.a ?? -1;
    default:
      return -1;
  }
}

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
  const { selection, marks, parent, details, message, sections } = s;
  if (selection.kind === 'none') return { panel: null, panelPending: false };
  const want = sectionSpecs(selection, parent).map((x) => filesKey(x.spec));
  const complete = sections.length === want.length
    && sections.every((x, i) => filesKey(x.spec) === want[i] && settled(x.list))
    && (selection.kind !== 'commit' || (settledFor(details, selection.id) && settledFor(message, selection.id)));
  if (!complete) return { panel: s.panel, panelPending: true };
  const p = s.panel;
  if (p && p.selection === selection && p.marks === marks && p.parent === parent && p.details === details && p.message === message && p.sections === sections) return { panel: p, panelPending: false };
  return { panel: { selection, marks, parent, details, message, sections }, panelPending: false };
}

export function createRepoViewStore(repo: number, repoPath: string, graph: GraphPayload, services: RepoServices): RepoViewStore {
  // Bumped on every selection change; results for an older selection are dropped.
  let seq = 0;

  return createStore<RepoViewState>((rawSet, get) => {
    /** Every update also settles what the panel shows (`panelFor`), in the same update. */
    const set = (patch: Partial<RepoViewState> | ((s: RepoViewState) => Partial<RepoViewState>)) =>
      rawSet((st) => {
        const p = typeof patch === 'function' ? patch(st) : patch;
        return { ...p, ...panelFor({ ...st, ...p }) };
      });

    function load<T>(source: Source<T>, key: string, apply: (l: Loadable<T>) => void, mySeq: number) {
      const hit = source.peek(key);
      if (hit !== undefined) {
        apply({ status: 'ready', data: hit });
        return;
      }
      apply({ status: 'loading' });
      source.get(key).then(
        (data) => { if (mySeq === seq) apply({ status: 'ready', data }); },
        (e: unknown) => { if (mySeq === seq) apply({ status: 'error', message: errorMessage(e) }); },
      );
    }

    function loadSections(specs: { title: string | null; spec: DiffSpec }[], mySeq: number) {
      set({ sections: specs.map((s) => ({ ...s, list: { status: 'loading' } })) });
      specs.forEach((s, i) => load(services.files, filesKey(s.spec), (list) => {
        if (mySeq === seq) set((st) => ({ sections: st.sections.map((sec, j) => (j === i ? { ...sec, list } : sec)) }));
      }, mySeq));
    }

    function loadCommit(id: string, mySeq: number) {
      load(services.details, id, (details) => set({ details }), mySeq);
      load(services.messages, id, (message) => set({ message }), mySeq);
    }

    /** Leaves every selection: late results for the old one are dropped. */
    function clearSelection(extra: Partial<RepoViewState> = {}) {
      ++seq;
      set({ selection: { kind: 'none' }, marks: NO_MARKS, details: IDLE, message: IDLE, sections: [], diff: null, ...extra });
    }

    function requestFocus(zone: FocusZone, extra: Partial<RepoViewState> = {}) {
      set((st) => ({ ...extra, focus: zone, focusRequest: st.focusRequest + 1 }));
    }

    /** `marks` land in the same update as the selection, so the panel never shows the new
     * marks (the compare hint) on the previous commit. */
    function selectCommit(index: number, marks: CompareMarks) {
      const rows = get().graph.rows;
      const row = rows[index];
      const mySeq = ++seq;
      perf.start('details');
      const selection: Selection = { kind: 'commit', index, id: row.id };
      set({ selection, marks, parent: 0, diff: null, details: IDLE, message: IDLE });
      loadCommit(row.id, mySeq);
      loadSections(sectionSpecs(selection, 0), mySeq);
      // The neighbours' details, file lists and messages: Up/Down then swaps the panel at once.
      const near = [index - 1, index + 1].filter((i) => i >= 0 && i < rows.length && rows[i].kind !== 'wip').map((i) => rows[i].id);
      services.details.prefetch(near);
      services.files.prefetch(near.map((id) => filesKey({ kind: 'commit', id, parent: 0 })));
      for (const id of near) if (!services.messages.peek(id)) services.messages.get(id).catch(() => {});
    }

    /** `reopen`: the diff open before a swap. It stays open while the reversed list loads, then
     * moves to the same file in that list (a rename under its old path), or closes. */
    function startCompare(from: string, to: string, marks: CompareMarks, reopen: DiffTarget | null = null) {
      const mySeq = ++seq;
      const spec: DiffSpec = { kind: 'compare', from, to };
      const selection: Selection = { kind: 'compare', from, to };
      set({ selection, marks, diff: reopen, details: IDLE, message: IDLE });
      loadSections(sectionSpecs(selection, 0), mySeq);
      if (!reopen) return;
      const stillOpen = () => mySeq === seq && get().diff === reopen;
      services.files.get(filesKey(spec)).then((list) => {
        if (!stillOpen()) return;
        const i = list.files.findIndex((f) => f.path === reopen.path || (reopen.oldPath !== null && f.path === reopen.oldPath && f.oldPath === reopen.path));
        if (i < 0) set({ diff: null });
        else get().openFile({ ...targetFor(list.files[i], spec), view: reopen.view }, list.files.slice(i + 1, i + 2).map((f) => targetFor(f, spec)));
      }, () => { if (stillOpen()) set({ diff: null }); });
    }

    return {
      repo,
      repoPath,
      services,
      graph,
      indexById: indexGraph(graph),
      selection: { kind: 'none' },
      marks: NO_MARKS,
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

      setFileListCursor(key) {
        if (get().fileListCursor !== key) set({ fileListCursor: key });
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
        }
        const marks = { a: remap(prev.marks.a), b: remap(prev.marks.b) };
        // The selected commit or worktree is gone: clear what was shown for it.
        if (selection.kind === 'none' && prev.selection.kind !== 'none') clearSelection({ graph: next, indexById, marks });
        else set({ graph: next, indexById, selection, marks });
      },

      selectRow(index, mods = {}) {
        const { graph: g, marks, selection } = get();
        const row = g.rows[index];
        if (!row) return;
        if (mods.ctrl && row.kind !== 'wip') {
          if (marks.a === null || marks.a === index || selection.kind === 'compare') selectCommit(index, { a: index, b: null });
          else startCompare(g.rows[marks.a].id, row.id, { a: marks.a, b: index });
          return;
        }
        if (row.kind === 'wip' && row.wip) {
          const w = row.wip;
          const mySeq = ++seq;
          const wip: Selection = { kind: 'wip', index, worktree: w.worktreePath, name: w.worktreeName };
          set({ selection: wip, marks: NO_MARKS, diff: null, details: IDLE, message: IDLE });
          loadSections(sectionSpecs(wip, 0), mySeq);
        } else {
          selectCommit(index, NO_MARKS);
        }
      },

      selectCommitById(id) {
        const i = get().indexById.get(id);
        if (i === undefined) return false;
        get().selectRow(i);
        return true;
      },

      swapCompare() {
        const { selection, marks, diff } = get();
        if (selection.kind === 'compare') startCompare(selection.to, selection.from, { a: marks.b, b: marks.a }, diff);
      },

      exitCompare() {
        const { selection, marks } = get();
        const target = marks.b ?? marks.a;
        if (selection.kind !== 'compare' && selection.kind !== 'compareWorktree' && marks.a === null) return;
        // Both clear the marks, in the same update as the new selection.
        if (target !== null) get().selectRow(target);
        else clearSelection();
      },

      compareWithWorktree(from, worktree) {
        const mySeq = ++seq;
        const a = get().indexById.get(from) ?? null;
        const selection: Selection = { kind: 'compareWorktree', from, worktree };
        set({ selection, marks: { a, b: null }, diff: null, details: IDLE, message: IDLE });
        loadSections(sectionSpecs(selection, 0), mySeq);
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
        const sections = get().sections;
        const step = (i: number): void => {
          const section = sections[i];
          if (mySeq !== seq || !section) return;
          const use = (list: FileListPayload) => {
            if (mySeq !== seq) return;
            if (list.files.length === 0) return step(i + 1);
            const targets = order(list.files, section.spec);
            get().openFile(targets[0], targets.slice(1, 2));
            requestFocus('files');
          };
          if (section.list.status === 'ready') use(section.list.data);
          else services.files.get(filesKey(section.spec)).then(use, () => step(i + 1));
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
