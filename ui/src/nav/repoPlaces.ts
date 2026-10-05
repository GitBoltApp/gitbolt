import type { DiffSpec } from '../api/gen/DiffSpec';
import { selectCommit } from '../app/graphNav';
import { tabView, useTabViews, type TabView } from '../app/tabStores';
import { useDiffPrefs } from '../diff/diffPrefs';
import { isMarkdownPath } from '../diff/markdownFiles';
import { shortSha } from '../format/sha';
import { MR_FLYOUT } from '../forge/mrStore';
import { contentKey } from '../repo/services';
import { contentsRequest, fileViewTarget, openWorktree, targetFor, worktreeViewTarget, type DiffTarget, type RepoViewState, type RepoViewStore } from '../repo/store';
import { closeFlyout, flyoutOf } from '../ui/flyout/flyout';
import { useToast } from '../ui/toast';
import { dropHistory, placeKey, recordPlace, registerPlaceKind, type FileCommit, type Place, type PlaceView } from './history';
import { scrollOf, setPendingScroll } from './scroll';

type FilePlace = Extract<Place, { kind: 'file' }>;
const toast = (m: string) => useToast.getState().show(m);

/**
 * The commit a File View target shows its file at; `'worktree'` for the working-tree file. A
 * list row's sides are blob ids, so the selection says which commit: a compare's TO, a WIP row's
 * worktree (File View of a WIP file shows its working-tree file, `worktreeFileTarget`). `null`
 * when there's nothing to come back to: a deleted file, a multi-selection.
 */
export function fileCommitOf(s: Pick<RepoViewState, 'selection'>, t: DiffTarget): FileCommit | null {
  if (t.new.kind === 'worktree') return 'worktree';
  if (t.new.kind === 'atCommit') return t.new.commit;
  if (t.new.kind === 'absent') return null;
  switch (s.selection.kind) {
    case 'commit': return s.selection.id;
    case 'compare': return s.selection.to;
    case 'wip':
    case 'compareWorktree': return 'worktree';
    default: return null;
  }
}

const viewOf = (path: string): PlaceView => (isMarkdownPath(path) ? useDiffPrefs.getState().prefs.markdownView : 'source');

/** The navigation place a File View of `t` is; `null` for a Diff View or a file with no commit. */
export function filePlaceOf(s: Pick<RepoViewState, 'selection'>, t: DiffTarget): FilePlace | null {
  if (t.view !== 'file') return null;
  const commit = fileCommitOf(s, t);
  return commit === null ? null : { kind: 'file', path: t.path, commit, view: viewOf(t.path), scrollTop: 0 };
}

/** `placeKey` of that place: FileView's and the rendered view's scroll key. */
export function filePlaceKey(s: Pick<RepoViewState, 'selection'>, t: DiffTarget): string | null {
  const p = filePlaceOf(s, t);
  return p ? placeKey(p) : null;
}

/** The file list a target belongs to: its key without `|<path>` (and "View all files"' `|all`). */
function listOf(t: DiffTarget): string {
  const k = t.key.endsWith(`|${t.path}`) ? t.key.slice(0, -(t.path.length + 1)) : t.key;
  return k.endsWith('|all') ? k.slice(0, -4) : k;
}

/** Whether the selection already shows `commit`'s files. */
function shows(s: RepoViewState, commit: FileCommit): boolean {
  if (commit === 'worktree') return s.selection.kind === 'wip' || s.selection.kind === 'compareWorktree';
  return (s.selection.kind === 'commit' && s.selection.id === commit) || (s.selection.kind === 'compare' && s.selection.to === commit);
}

/** The worktree a `'worktree'` place means: the open file's, the selected WIP row's, else the tab's own. */
function worktreeOf(s: RepoViewState): string {
  if (s.diff?.new.kind === 'worktree') return s.diff.new.worktree;
  if (s.selection.kind === 'wip' || s.selection.kind === 'compareWorktree') return s.selection.worktree;
  return openWorktree(s);
}

/** The file's row in the selection's loaded lists, as a File View target (so the list marks it). */
function listTarget(s: RepoViewState, path: string): DiffTarget | null {
  for (const sec of s.sections) {
    if (sec.list.status !== 'ready') continue;
    const f = sec.list.data.files.find((x) => x.path === path);
    if (f) return { ...targetFor(f, sec.spec), view: 'file' };
  }
  return null;
}

const closeMrView = (tabId: string) => {
  if (flyoutOf(tabId)?.kind === MR_FLYOUT) closeFlyout(tabId);
};

export interface OpenFileOptions {
  /** Add a place first (a Markdown link). Back/Forward restore without one. */
  record?: boolean;
  /** A heading to scroll to in the rendered view. */
  anchor?: string | null;
  /** Where its view scrolls once shown (a restore). */
  scrollTop?: number;
  /** Close the MR/PR flyout, which would cover the file (a restore). */
  closeMrView?: boolean;
}

/**
 * Opens `path` at `commit` in File View (spec #5 §3.4, §4.1). The file is read first: one that
 * isn't there says so ("<path> isn't in <sha>") and nothing changes. Then, once leaving the
 * open file is settled (its unsaved edits, `leaveThen`): the place is recorded (`record`), the
 * commit or WIP row is selected if it isn't already, and the file opens, as its list row when
 * the list is loaded. False when it couldn't open.
 */
export async function openFileAt(tabId: string, path: string, commit: FileCommit, opts: OpenFileOptions = {}): Promise<boolean> {
  const v: TabView | undefined = tabView(tabId);
  if (!v) return false;
  const s = v.store.getState();
  if (commit !== 'worktree' && !s.indexById.has(commit)) {
    toast(`${shortSha(commit)} isn't in the loaded history`);
    return false;
  }
  const worktree = commit === 'worktree' ? worktreeOf(s) : null;
  const spec: DiffSpec = worktree !== null ? { kind: 'wip', worktree, staged: false } : { kind: 'commit', id: commit, parent: 0 };
  const probe = worktree !== null ? worktreeViewTarget(path, worktree, spec) : fileViewTarget(path, commit, spec);
  try {
    await v.services.contents.get(contentKey(contentsRequest(probe)));
  } catch {
    toast(worktree !== null ? `${path} isn't in the working tree` : `${path} isn't in ${shortSha(commit)}`);
    return false;
  }
  const place: FilePlace = { kind: 'file', path, commit, view: viewOf(path), scrollTop: 0 };
  v.store.getState().leaveThen(() => {
    if (opts.record) recordPlace(tabId, place);
    if (opts.closeMrView) closeMrView(tabId);
    if (opts.anchor || opts.scrollTop) setPendingScroll(tabId, 'file', { key: placeKey(place), view: place.view, top: opts.scrollTop ?? 0, anchor: opts.anchor ?? null });
    const st = v.store.getState();
    if (!shows(st, commit)) {
      if (worktree !== null) {
        const i = st.graph.rows.findIndex((r) => r.wip?.worktreePath === worktree);
        if (i >= 0) st.selectRow(i);
      } else {
        st.selectCommitById(commit);
      }
    }
    const now = v.store.getState();
    now.openFile(listTarget(now, path) ?? probe);
  });
  return true;
}

const offFile = registerPlaceKind('file', {
  capture: (tabId, p) => {
    const top = scrollOf(tabId, 'file', placeKey(p));
    return { ...p, view: viewOf(p.path), scrollTop: top ?? p.scrollTop };
  },
  async restore(tabId, p) {
    const prefs = useDiffPrefs.getState();
    if (isMarkdownPath(p.path) && prefs.prefs.markdownView !== p.view) prefs.set({ markdownView: p.view });
    return openFileAt(tabId, p.path, p.commit, { scrollTop: p.scrollTop, closeMrView: true });
  },
});

const offCommit = registerPlaceKind('commit', {
  async restore(tabId, p) {
    if (!selectCommit(tabId, p.sha, { focus: true })) {
      toast(`${shortSha(p.sha)} isn't in the loaded history`);
      return false;
    }
    closeMrView(tabId);
    return true;
  },
});

/** A tab's store: a file opened in File View is a place (from anywhere: the file list, a menu,
 * the palette, a link). Opening another file of the same list while one is open in File View
 * (stepping through "View all files") replaces it. Graph selection and Diff View add none. */
function watch(tabId: string, store: RepoViewStore): () => void {
  return store.subscribe((s, prev) => {
    const d = s.diff;
    if (!d || d.view !== 'file' || (prev.diff?.key === d.key && prev.diff.view === 'file')) return;
    const place = filePlaceOf(s, d);
    if (!place) return;
    const stepping = prev.diff?.view === 'file' && listOf(prev.diff) === listOf(d);
    recordPlace(tabId, place, stepping ? 'replace' : 'push');
  });
}

const watched = new Map<string, { store: RepoViewStore; off: () => void }>();
function sync(views: Record<string, TabView>): void {
  for (const [id, v] of Object.entries(views)) {
    const w = watched.get(id);
    if (w?.store === v.store) continue;
    if (w) {
      w.off();
      dropHistory(id); // the tab moved to another repository
    }
    watched.set(id, { store: v.store, off: watch(id, v.store) });
  }
  for (const [id, w] of watched) {
    if (views[id]) continue;
    w.off();
    watched.delete(id);
    dropHistory(id);
  }
}
sync(useTabViews.getState().views);
const offViews = useTabViews.subscribe((s) => sync(s.views));

import.meta.hot?.dispose(() => {
  offFile();
  offCommit();
  offViews();
  for (const w of watched.values()) w.off();
  watched.clear();
});
