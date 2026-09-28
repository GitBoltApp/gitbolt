import { api, errorMessage } from '../api/client';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import { copyText } from '../api/transport';
import { projectRemote, type ProjectRemote } from '../forge/urls';
import { labelsByRowOf, membershipOf } from '../graph/graphIndex';
import { loadOpeners, openersSnapshot, openVersion, openWith, refreshOpeners, subscribeOpeners, worktreeOf, type OpenInTarget } from '../openIn/openers';
import type { RepoServices } from '../repo/services';
import type { DiffTarget, RepoViewState, RepoViewStore } from '../repo/store';
import { useToast } from '../ui/toast';
import './builders';
import { refreshMenuOn } from './menuStore';
import { buildMenu } from './registry';
import type { MenuRow } from './types';

// Plan 1C Task 15's `menuEnv`, file menu only, pulled into 1B on the RepoView store. 1C's
// version reads its app state (`useRuntime`, `useAppState`, Task 9); this one reads the one
// RepoView store a file list lives in. Everything a builder sees is in memory (spec §7): no
// backend call before a menu shows.

export interface Upstream { remote: string; branch: string }

/** A file-list row the file menu is for (spec §7 "File"). */
export interface FileTarget {
  /** Repository-relative (the new path of a rename). */
  path: string;
  /** The folder `path` is relative to on disk: the list's worktree, else the repository's. */
  root: string;
  /** The commit whose version of the file the row stands for (a deleted file: the commit
   * before, where it still exists); `null` for the working tree or the index. */
  sha: string | null;
  /** The upstream of the selected commit's branch, when one is known (the forge ⎇ link). */
  upstream: Upstream | null;
  /** The row's diff target (Open diff, View file). */
  diff: DiffTarget;
  /** False for an unchanged file from "View all files": it has no diff. */
  changed: boolean;
  deleted: boolean;
  /** The kind of list the row is in: a commit's, a compare's, one with the working tree, WIP. */
  list: DiffSpec['kind'];
  /** What Open in ▸ opens: the working-tree file in a worktree list, else the version shown. */
  openIn: OpenInTarget;
}

export interface MenuActions {
  copy(text: string): void;
  openUrl(url: string): void;
  openIn(opener: OpenerPayload, target: OpenInTarget): void;
  openDiff(target: DiffTarget): void;
  viewFile(target: DiffTarget): void;
}

export interface MenuEnv {
  /** The forge for `remote` (the project remote when omitted), or null: none known, or a
   * generic host. */
  forge(remote?: string): ProjectRemote | null;
  openers: { list: OpenerPayload[] | null; error: string | null; last: string | null };
  act: MenuActions;
}

/** A folder row the folder menu is for. */
export interface FolderTarget {
  /** Repository-relative. */
  path: string;
  root: string;
  /** What Open in ▸ Files opens: a path inside the folder (a file manager shows the folder of
   * the path it's given). */
  openIn: OpenInTarget;
}

/** Listeners for "the remotes arrived" (an open menu gains its Forge row). `services.
 * remotesSnapshot()` is the one cache of "this repo's remotes, loaded" (also read by
 * `useProjectRemote`, `details/Message.tsx`); menus read it synchronously. */
const remoteListeners = new Set<() => void>();

function loadRemotes(services: RepoServices): void {
  if (services.remotesSnapshot()) return;
  services.remotes().then(() => remoteListeners.forEach((f) => f()), () => {});
}

/** Loads what the file menu shows ahead of the first right-click: the openers, the remotes,
 * and the graph indexes the ⎇ link reads (when the graph view hasn't built them already). */
export function warmFileMenu(services: RepoServices, graph?: GraphPayload): void {
  loadOpeners().catch(() => {});
  loadRemotes(services);
  if (graph) membershipOf(graph.rows, labelsByRowOf(graph.labels), graph.pinnedRef);
}

/** After the menu has painted (the next frame, then a task): nothing reaches the backend before
 * a menu shows (spec §7). */
function afterPaint(fn: () => void): void {
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16);
  raf(() => setTimeout(fn, 0));
}

const toast = (m: string) => useToast.getState().show(m);

/** The file menu's env, from the store's current state. */
export function fileMenuEnv(store: RepoViewStore): MenuEnv {
  const s = store.getState();
  const remotes = s.services.remotesSnapshot() ?? [];
  return {
    forge: (remote) => {
      const r = projectRemote(remote === undefined ? remotes : remotes.filter((x) => x.name === remote));
      return r && r.hostKind !== 'generic' ? r : null;
    },
    openers: openersSnapshot(),
    act: {
      copy: (text) => { copyText(text).then(() => toast('Copied'), () => toast('Copy failed')); },
      openUrl: (url) => { api.openUrl(url).catch((e: unknown) => toast(errorMessage(e))); },
      openIn: (o, t) => openWith(s.repo, o, t),
      openDiff: (t) => store.getState().openFile({ ...t, view: 'diff' }),
      viewFile: (t) => store.getState().openFile({ ...t, view: 'file' }),
    },
  };
}

/** The graph's shared indexes (graphIndex.ts): GraphView has built them by the time a menu
 * opens. */
function graphInfo(g: GraphPayload) {
  const byRow = labelsByRowOf(g.labels);
  return { byRow, membership: membershipOf(g.rows, byRow, g.pinnedRef) };
}

const upstreamFrom = (r: RemoteRefLabel): Upstream => ({ remote: r.remote, branch: r.fullName.slice(`refs/remotes/${r.remote}/`.length) });
const originFirst = (rs: RemoteRefLabel[]) => rs.find((r) => r.remote === 'origin') ?? rs[0];

/** A local branch's upstream as far as the graph knows: a remote-tracking branch of the same
 * name (origin first). */
function sameNamed(g: GraphPayload, branch: string): Upstream | null {
  const r = originFirst(g.labels.flatMap((l) => l.remotes.filter((x) => upstreamFrom(x).branch === branch)));
  return r ? upstreamFrom(r) : null;
}

/**
 * The upstream of the branch `sha` is on (spec §7, the file menu's ⎇): the branches whose tip
 * it is (HEAD's first), else the branch it belongs to (the graph's first-parent membership,
 * F7). A remote-tracking branch is its own; a local branch's is inferred as the same-named
 * remote-tracking branch, since 1B's payloads carry no configured upstreams (plan 1C: use the
 * sidebar's). Null when none is known.
 */
export function upstreamOf(g: GraphPayload, indexById: Map<string, number>, sha: string): Upstream | null {
  const i = indexById.get(sha);
  if (i === undefined) return null;
  const { byRow, membership } = graphInfo(g);
  const labels = (byRow.get(i) ?? []).filter((l) => !l.tag).sort((a, b) => Number(b.isHead) - Number(a.isHead));
  for (const l of labels) {
    const own = originFirst(l.remotes);
    if (own) return upstreamFrom(own);
    const up = l.local ? sameNamed(g, l.local.replace(/^refs\/heads\//, '')) : null;
    if (up) return up;
  }
  const m = membership[i];
  if (!m) return null;
  if (m.ref.startsWith('refs/heads/')) return sameNamed(g, m.ref.slice('refs/heads/'.length));
  const r = g.labels.flatMap((l) => l.remotes).find((x) => x.fullName === m.ref);
  return r ? upstreamFrom(r) : null;
}

/** The commits a row's file belongs to: the version's (`sha`) and the one whose branch the forge
 * link uses (`branch`). */
function commitsOf(s: RepoViewState, spec: DiffSpec, t: DiffTarget, deleted: boolean): { sha: string | null; branch: string | null } {
  if (t.new.kind === 'atCommit') return { sha: t.new.commit, branch: t.new.commit };
  switch (spec.kind) {
    case 'commit': {
      const parent = s.graph.rows[s.indexById.get(spec.id) ?? -1]?.parents[spec.parent] ?? null;
      return { sha: deleted ? parent : spec.id, branch: spec.id };
    }
    case 'compare':
      return { sha: deleted ? spec.from : spec.to, branch: spec.to };
    case 'worktree':
      return { sha: deleted ? spec.from : null, branch: spec.from };
    case 'wip': {
      const row = s.graph.rows.find((r) => r.wip?.worktreePath === spec.worktree);
      return { sha: null, branch: row?.parents[0] ?? null };
    }
  }
}

/** The file menu's target for row `t` of the list for `spec`. */
export function fileTargetOf(s: RepoViewState, spec: DiffSpec, t: DiffTarget, changed: boolean): FileTarget {
  const inWorktree = spec.kind === 'wip' || spec.kind === 'worktree' ? spec.worktree : null;
  const root = inWorktree ?? worktreeOf(t) ?? s.repoPath;
  const deleted = t.new.kind === 'absent';
  const { sha, branch } = commitsOf(s, spec, t, deleted);
  return {
    path: t.path,
    root,
    sha,
    upstream: branch ? upstreamOf(s.graph, s.indexById, branch) : null,
    diff: t,
    changed,
    deleted,
    list: spec.kind,
    openIn: { worktree: root, path: t.path, line: null, ...openVersion(t, inWorktree) },
  };
}

/** Once the menu has painted: re-detect the openers (H32) and load the remotes if they never
 * were. An open menu fills in when either arrives. */
function afterOpening(store: RepoViewStore): void {
  afterPaint(() => {
    refreshOpeners().catch(() => {});
    loadRemotes(store.getState().services);
  });
}

/** A right-click on a file row: the synchronous builder `openContextMenu` runs. */
export function fileMenu(store: RepoViewStore, spec: DiffSpec, t: DiffTarget, changed: boolean): () => MenuRow[] {
  afterOpening(store);
  return () => buildMenu<FileTarget, MenuEnv>('file', fileTargetOf(store.getState(), spec, t, changed), fileMenuEnv(store));
}

/** The folder menu's target: `inside`, a path in the folder, is what Open in ▸ Files opens. */
export function folderTargetOf(s: RepoViewState, spec: DiffSpec, path: string, inside: string): FolderTarget {
  const root = spec.kind === 'wip' || spec.kind === 'worktree' ? spec.worktree : s.repoPath;
  return { path, root, openIn: { worktree: root, path: inside, line: null, source: null, fallback: null } };
}

/** A right-click on a folder row (tree mode). */
export function folderMenu(store: RepoViewStore, spec: DiffSpec, path: string, inside: string): () => MenuRow[] {
  afterOpening(store);
  return () => buildMenu<FolderTarget, MenuEnv>('folder', folderTargetOf(store.getState(), spec, path, inside), fileMenuEnv(store));
}

// An open menu rebuilds when the openers or the remotes arrive (its Open in ▸ and Forge rows).
// Module-scope subscriptions: released on `import.meta.hot`'s dispose, so a dev-server hot
// update of this module (or `builders`, which imports it) doesn't add another one each time —
// harmless (a rebuild just runs twice), but it grows over a long dev session.
const offOpeners = refreshMenuOn(subscribeOpeners);
const offRemotes = refreshMenuOn((fn) => {
  remoteListeners.add(fn);
  return () => { remoteListeners.delete(fn); };
});
import.meta.hot?.dispose(() => {
  offOpeners();
  offRemotes();
});
