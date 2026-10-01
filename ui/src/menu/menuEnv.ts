import { api, errorMessage } from '../api/client';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { copyText } from '../api/transport';
import type { EditorContextMenuEvent } from '../diff/monaco/host';
import { projectRemote, type ProjectRemote } from '../forge/urls';
import { labelsByRowOf, membershipOf } from '../graph/graphIndex';
import { loadOpeners, openersSnapshot, openVersion, openWith, parseListSpec, refreshOpeners, subscribeOpeners, worktreeOf, type OpenInTarget } from '../openIn/openers';
import type { RepoServices } from '../repo/services';
import { openWorktree, type DiffTarget, type RepoViewState, type RepoViewStore } from '../repo/store';
import { useToast } from '../ui/toast';
import './builders';
import { refreshMenuOn } from './menuStore';
import { buildMenu } from './registry';
import type { MenuRow } from './types';

// Plan 1C Task 15's `menuEnv`, pulled into 1B on the RepoView store: file and folder shipped in
// 1B (fb3 lane M); commit, tag and Monaco are 1C's own (lane W2-D). 1C's version reads its app
// state (`useRuntime`, `useAppState`, Task 9); this one reads the one RepoView store a tab's
// graph, file lists and diff live in. Everything a builder sees is in memory (spec §7): no
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
  /** Compares two commits (K15), or a commit with the working tree (plan 1C Task 15's commit
   * menu "Compare with HEAD"/"Compare with working tree"). */
  compare(from: string, to: string | 'worktree'): void;
  /** Copies a commit's full message (summary + body), loading it first if it isn't cached. */
  copyMessage(sha: string): void;
}

export interface MenuEnv {
  /** The forge for `remote` (the project remote when omitted), or null: none known, or a
   * generic host. */
  forge(remote?: string): ProjectRemote | null;
  openers: { list: OpenerPayload[] | null; error: string | null; last: string | null };
  act: MenuActions;
  /** HEAD's branch (short name) and commit, for the commit menu's "Compare with HEAD" label and
   * guard (spec §7 target table). `null` on an unborn or detached HEAD. */
  headBranch: string | null;
  headSha: string | null;
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

/** A commit's branch, as the graph knows it (spec §7 "Copy branch name", "Forge link"). */
export interface BranchRef { name: string; local: string | null; remotes: Array<{ fullName: string; remote: string }> }

/** A commit row, or a branch label chip on one (plan 1C Task 15, `commit` kind). `branch` is set
 * only when the menu opened on a branch label chip; a plain right-click on the row leaves it
 * `null` (spec §7: the row and its labels are separate targets). */
export interface CommitTarget {
  sha: string;
  /** MR/PR reference labels from the commit message, exactly as `RowPayload.mrRefs` has them
   * (`"!42"`, `"acme/shop!1187"`, `"#12"`): the commit menu's `Open <ref>` rows. */
  mrRefs: string[];
  isWip: boolean;
  branch: BranchRef | null;
}

/** A tag label chip (`tag` kind). */
export interface TagTarget { name: string; fullName: string; sha: string }

/** The Monaco context menu's target (`monaco` kind): the diff or file editor's selection, at the
 * commit (or working tree, `sha: null`) the open file shows. */
export interface MonacoTarget {
  path: string;
  sha: string | null;
  lines: [number, number];
  selectionText: string;
  upstream: Upstream | null;
  /** What Open in ▸ opens: the same version the file list's row would (spec §14.5), at `lines[0]`. */
  openIn: OpenInTarget;
}

export const commitTargetOf = (row: RowPayload, branch: BranchRef | null = null): CommitTarget =>
  ({ sha: row.id, mrRefs: row.mrRefs, isWip: row.kind === 'wip', branch });

export const branchRefOf = (label: RefLabel): BranchRef =>
  ({ name: label.name, local: label.local, remotes: label.remotes.map((r) => ({ fullName: r.fullName, remote: r.remote })) });

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

/** Copies a commit's full message, loading it first if it isn't cached (the commit menu's "Copy
 * message"; the graph payload carries only the summary and body's first line, §9.2). Exported
 * (fix round 1, item 7) for a direct unit test, alongside `compare`. */
export function copyMessage(store: RepoViewStore, sha: string): void {
  const cache = store.getState().services.messages;
  const format = (m: CommitMessage) => (m.body ? `${m.summary}\n\n${m.body}` : m.summary);
  const cached = cache.peek(sha);
  const text = cached ? Promise.resolve(format(cached)) : cache.get(sha).then(format);
  text.then((t) => copyText(t)).then(() => toast('Copied'), () => toast('Copy failed'));
}

/** "Compare with HEAD" / "Compare with working tree" (the commit menu's `view` group): drives
 * the right-clicked commit `from` is FROM, HEAD (or the working tree) TO, and the anchor and the
 * keyboard stay on `from` (K27), so Esc returns there and the graph doesn't jump to HEAD.
 * Exported (fix round 1, item 7) for a direct unit test. */
export function compare(store: RepoViewStore, from: string, to: string | 'worktree'): void {
  const s = store.getState();
  if (to === 'worktree') {
    s.compareWithWorktree(from, openWorktree(s));
    return;
  }
  s.compareCommits(from, to);
}

/** The menu env, from the store's current state: file and folder (1B), commit, tag and Monaco
 * (1C, Task 15). */
export function fileMenuEnv(store: RepoViewStore): MenuEnv {
  const s = store.getState();
  const remotes = s.services.remotesSnapshot() ?? [];
  const head = s.graph.head;
  return {
    forge: (remote) => {
      const r = projectRemote(remote === undefined ? remotes : remotes.filter((x) => x.name === remote));
      return r && r.hostKind !== 'generic' ? r : null;
    },
    openers: openersSnapshot(),
    headBranch: head.branch?.replace(/^refs\/heads\//, '') ?? null,
    headSha: head.target,
    act: {
      copy: (text) => { copyText(text).then(() => toast('Copied'), () => toast('Copy failed')); },
      openUrl: (url) => { api.openUrl(url).catch((e: unknown) => toast(errorMessage(e))); },
      openIn: (o, t) => openWith(s.repo, o, t),
      openDiff: (t) => store.getState().openFile({ ...t, view: 'diff' }),
      viewFile: (t) => store.getState().openFile({ ...t, view: 'file' }),
      compare: (from, to) => compare(store, from, to),
      copyMessage: (sha) => copyMessage(store, sha),
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

/** A right-click on a graph row, or on a branch label chip (`branch` set): plan 1C Task 15. WIP
 * rows get no commit menu (`commitTargetOf`'s `isWip`; the builders gate on it too). */
export function commitMenu(store: RepoViewStore, row: RowPayload, branch: BranchRef | null = null): () => MenuRow[] {
  afterOpening(store);
  return () => buildMenu<CommitTarget, MenuEnv>('commit', commitTargetOf(row, branch), fileMenuEnv(store));
}

/** A right-click on a tag label chip. */
export function tagMenu(store: RepoViewStore, sha: string, label: RefLabel): () => MenuRow[] {
  afterOpening(store);
  return () => buildMenu<TagTarget, MenuEnv>('tag', { name: label.name, fullName: `refs/tags/${label.name}`, sha }, fileMenuEnv(store));
}

/** A right-click on a graph label chip (`GraphView`/`RefLabels`): dispatches to the commit or tag
 * menu by the label's own kind. */
export function labelMenu(store: RepoViewStore, row: RowPayload, label: RefLabel): () => MenuRow[] {
  return label.tag ? tagMenu(store, row.id, label) : commitMenu(store, row, branchRefOf(label));
}

/** The Monaco context menu's target: the open diff's side `e` fired on, at the commit (or working
 * tree) that side shows. `null` while no diff is open (shouldn't happen: the handler is only
 * installed then) or the diff's list has no matching, loaded section (a stale event from an
 * editor mid-teardown). Exported (fix round 1, item 7) for a direct unit test. */
export function monacoTargetOf(s: RepoViewState, e: EditorContextMenuEvent): MonacoTarget | null {
  const diff = s.diff;
  if (!diff) return null;
  const onOld = e.side === 'original';
  const path = onOld ? (diff.oldPath ?? diff.path) : diff.path;
  const lines: [number, number] = e.selection ? [e.selection.startLine, e.selection.endLine] : [e.line, e.line];
  const spec = parseListSpec(diff.key);
  // `commitsOf` (also `fileTargetOf`'s) picks the commit for one side of a diff by its `deleted`
  // flag: the old side's commit for a deleted file, else the new side's. The old/new side split
  // is exactly what a side's own commit needs here too, so `onOld` fills that role directly —
  // there's no real BlobSource to read a commit id off (a diff's sides are usually plain blobs,
  // `object`/`worktree`/`absent`; `atCommit` is only File View's "unchanged file" case).
  const { sha, branch } = spec ? commitsOf(s, spec, diff, onOld) : { sha: null, branch: null };
  const inWorktree = spec && (spec.kind === 'wip' || spec.kind === 'worktree') ? spec.worktree : null;
  const root = inWorktree ?? worktreeOf(diff) ?? s.repoPath;
  return {
    path,
    sha,
    lines,
    selectionText: e.selectionText,
    upstream: branch ? upstreamOf(s.graph, s.indexById, branch) : null,
    // The same version the file list's row would open (spec §14.5), at the clicked line.
    openIn: { worktree: root, path, line: lines[0], ...openVersion(diff, inWorktree) },
  };
}

/** The builder for `MonacoHost.setContextMenuHandler`'s callback (installed while a tab is
 * active, plan 1C Task 15). There's no DOM `contextmenu` event to build from (the editor's own
 * was already suppressed by the host), so the caller shows the rows itself: `const build =
 * monacoMenu(store, e); const rows = build(); if (rows.length) useMenu.getState().show(rows, e.x,
 * e.y, performance.now(), build);`. */
export function monacoMenu(store: RepoViewStore, e: EditorContextMenuEvent): () => MenuRow[] {
  afterOpening(store);
  return () => {
    const t = monacoTargetOf(store.getState(), e);
    return t ? buildMenu<MonacoTarget, MenuEnv>('monaco', t, fileMenuEnv(store)) : [];
  };
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
