import { api, errorMessage } from '../api/client';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { copyText } from '../api/transport';
import { useAppState } from '../app/state';
import { tabIdOf } from '../app/tabStores';
import type { WriteCtx } from '../write/client';
import { withActiveSidebar } from '../worktrees/active';
import { worktreeDisplay } from '../worktrees/paths';
import type { EditorContextMenuEvent } from '../diff/monaco/host';
import { stagingRows } from '../diff/stagingMenu';
import { useRuntime } from '../app/runtime';
import { projectRemote, type ProjectRemote } from '../forge/urls';
import { isAncestorIn } from '../graph/ancestry';
import { labelsByRowOf, membershipOf } from '../graph/graphIndex';
import { loadOpeners, openersSnapshot, openVersion, openWith, parseListSpec, refreshOpeners, subscribeOpeners, worktreeOf, type OpenInTarget } from '../openIn/openers';
import { centerViewEditorFile, centerViewOf, centerViewOnTop } from '../repo/centerView';
import type { RepoServices } from '../repo/services';
import type { SideItem } from '../sidebar/model';
import { wipKey } from '../repo/wipLists';
import { inCommitSelection, openWorktree, selectedCommits, type CommitRef, type DiffTarget, type RepoViewState, type RepoViewStore } from '../repo/store';
import { useToast } from '../ui/toast';
import { stackBase, stackFor, stacksOf, type Stack } from '../stacks/detect';
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
  /** A WIP row's file (spec #2 §7.1): its worktree, its section and what the menu's Stage /
   * Unstage / Discard need (`submodule`: a submodule is discarded inside itself, so no Discard).
   * `null` for every other list. */
  wip: { worktree: string; staged: boolean; oldPath: string | null; status: string; submodule?: boolean } | null;
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
  /** Selects the commit in the graph and moves the keyboard there (the sidebar menus' "Show in
   * graph"); a toast when it isn't in the loaded history. */
  showInGraph(sha: string): void;
  /** Shows a worktree's own folder in the file manager. */
  openFolder(path: string): void;
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
  /** Whether the commit is among the graph's loaded rows ("Show in graph" is greyed otherwise). */
  inGraph(sha: string): boolean;
  // --- 2C T9: the 2C menu env ---
  /** Where a write from this menu runs: the tab, its repo, its active worktree (spec #2 §11.2). */
  write: WriteCtx | null;
  /** The tab's sidebar payload (upstreams, remote branches, worktrees, stashes), when loaded. */
  sidebar: SidebarPayload | null;
  /** The graph's labels on commit `sha` (Checkout ▸, Create worktree from ▸). */
  labelsAt(sha: string): RefLabel[];
  activeWorktree: string | null;
  mainWorktree: string | null;
  /** A merge, rebase… in the active worktree: Reset and checkout rows grey out. */
  inProgress: string | null;
  /** `../shop-x`, as messages name a worktree. */
  worktreeShown(path: string): string;
  // --- end 2C T9 ---
  /** Whether commit `a` is an ancestor of (or is) `b`, from the loaded rows (graph/ancestry.ts):
   * the menus hide what can't apply (a fast-forward of a branch that isn't behind). `null`, or
   * omitted: unknown, and the row shows, checked after the click. */
  isAncestor?(a: string, b: string): boolean | null;
  // --- 3D T3 ---
  /** The stack `branch` is in (spec #3 §3.11: the straight path through it), from the loaded
   * graph and the stack base; `null`: not stacked. Omitted: unknown. */
  stackOf?(branch: string): Stack | null;
  // --- end 3D T3 ---
  // --- 3B T5 ---
  /** The loaded row of commit `sha`: its summary and whether it's a merge. `null`: not in the
   * loaded graph (rows that need it show, and the backend checks after the click). */
  commitInfo?(sha: string): { summary: string; merge: boolean } | null;
  /** The repository's remotes by name: the tab's repo info, else the sidebar's groups. */
  remoteNames?: string[];
  // --- end 3B T5 ---
  // --- 3B final fixes ---
  /** The active worktree's conflicted (unmerged) files, from its WIP row: 0 when none or not
   * loaded. A stop without committing leaves them with nothing in progress. */
  conflicted?: number;
  // --- end 3B final fixes ---
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
  // --- 2C T9 ---
  /** A stash node (spec #2 §10: Apply, Pop, Delete on the graph's stash nodes). */
  isStash: boolean;
  // --- end 2C T9 ---
  branch: BranchRef | null;
}

// --- 2C T9: the wip menu kind ---
/** A WIP row (`wip` kind, spec #2 §14). */
export interface WipTarget { worktree: string; name: string | null; active: boolean }
// --- end 2C T9 ---

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

/** The sidebar menus' own rows (`sidebar` kind; branches and tags use the `commit` and `tag`
 * kinds, plus the "Show in graph" row). */
export type SidebarTarget =
  | { what: 'ref'; sha: string | null }
  | { what: 'remote'; name: string; url: string | null }
  | { what: 'worktree'; path: string; branch: string | null; head: string | null }
  | { what: 'stash'; sha: string; message: string };

export const commitTargetOf = (row: RowPayload, branch: BranchRef | null = null): CommitTarget =>
  ({ sha: row.id, mrRefs: row.mrRefs, isWip: row.kind === 'wip', isStash: row.kind === 'stash', branch });

export const branchRefOf = (label: RefLabel): BranchRef =>
  ({ name: label.name, local: label.local, remotes: label.remotes.map((r) => ({ fullName: r.fullName, remote: r.remote })) });

/** Listeners for "the remotes arrived" (an open menu gains its Forge row). `services.
 * remotesSnapshot()` is the one cache of "this repo's remotes, loaded" (also read by
 * `useProjectRemote`, `details/Message.tsx`); menus read it synchronously. */
const remoteListeners = new Set<() => void>();

function loadRemotes(services: RepoServices): void {
  if (services.remotesSnapshot()) return;
  // Through a promise, so a transport that throws (none, in unit tests) rejects instead, as
  // `refreshOpeners` does: the graph's warm-up runs this in an effect.
  Promise.resolve().then(() => services.remotes()).then(() => remoteListeners.forEach((f) => f()), () => {});
}

/** Loads what the file menu shows ahead of the first right-click: the openers, the remotes,
 * and the graph indexes the ⎇ link reads (when the graph view hasn't built them already). */
export function warmFileMenu(services: RepoServices, graph?: GraphPayload): void {
  loadOpeners().catch(() => {});
  loadRemotes(services);
  if (graph) membershipOf(graph.rows, labelsByRowOf(graph.labels), graph.pinnedRef);
}

/** Loads what the commit and label menus read ahead of the first right-click: the openers and the
 * remotes (their Open !N and Forge link rows). A right-click no longer selects the row, so the
 * details panel no longer starts the remotes' load; without this, the first menu painted without
 * those rows and gained them under the pointer, shifting Copy SHA and the rows below. */
export function warmCommitMenu(services: RepoServices): void {
  loadOpeners().catch(() => {});
  loadRemotes(services);
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
  // --- 2C T9: the 2C menu env ---
  const tabId = tabIdOf(store);
  const rt = tabId ? useRuntime.getState().tabs[tabId] : undefined;
  const active = rt?.worktree ?? openWorktree(s);
  const main = s.graph.worktrees.find((w) => w.isMain)?.path ?? s.repoPath;
  const byRow = labelsByRowOf(s.graph.labels);
  // --- end 2C T9 ---
  return {
    // --- 2C T9: the 2C menu env ---
    write: tabId && rt?.repo ? { tabId, repoId: rt.repo.id, worktree: active } : null,
    sidebar: sidebarFor(s.repo, active),
    labelsAt: (sha) => byRow.get(s.indexById.get(sha) ?? -1) ?? [],
    activeWorktree: active,
    mainWorktree: main,
    inProgress: s.graph.worktrees.find((w) => w.path === active)?.inProgress ?? null,
    worktreeShown: (path) => worktreeDisplay(main, path),
    // --- end 2C T9 ---
    isAncestor: (a, b) => isAncestorIn(s.graph.rows, s.indexById, a, b),
    // --- 3D T3 ---
    stackOf: (branch) => stackFor(stacksOf(s.graph, stackBase(s.graph, sidebarFor(s.repo, active)?.remotes ?? [])), branch, head.branch?.replace(/^refs\/heads\//, '') ?? null),
    // --- end 3D T3 ---
    // --- 3B T5 ---
    commitInfo: (sha) => {
      const r = s.graph.rows[s.indexById.get(sha) ?? -1];
      return r ? { summary: r.summary, merge: r.parents.length > 1 } : null;
    },
    remoteNames: rt?.info?.remotes.map((r) => r.name) ?? sidebarFor(s.repo, active)?.remotes.map((g) => g.name) ?? [],
    // --- end 3B T5 ---
    // --- 3B final fixes ---
    conflicted: s.graph.rows.find((r) => r.kind === 'wip' && r.wip?.worktreePath === active)?.wip?.conflicted ?? 0,
    // --- end 3B final fixes ---
    forge: (remote) => {
      const r = projectRemote(remote === undefined ? remotes : remotes.filter((x) => x.name === remote), useAppState.getState().profile.hostOverrides);
      return r && r.hostKind !== 'generic' ? r : null;
    },
    openers: openersSnapshot(),
    headBranch: head.branch?.replace(/^refs\/heads\//, '') ?? null,
    headSha: head.target,
    inGraph: (sha) => s.indexById.has(sha),
    act: {
      copy: (text) => { copyText(text).then(() => toast('Copied'), () => toast('Copy failed')); },
      openUrl: (url) => { api.openUrl(url).catch((e: unknown) => toast(errorMessage(e))); },
      openIn: (o, t) => openWith(s.repo, o, t),
      openDiff: (t) => store.getState().openFile({ ...t, view: 'diff' }),
      viewFile: (t) => store.getState().openFile({ ...t, view: 'file' }),
      compare: (from, to) => compare(store, from, to),
      copyMessage: (sha) => copyMessage(store, sha),
      showInGraph: (sha) => {
        const g = store.getState();
        if (g.selectCommitById(sha)) g.setFocus('graph');
        else toast('Not in the loaded history');
      },
      // No dedicated "open a folder" request: `openIn` with the file manager and any one valid
      // segment lands on the worktree itself (core `folder_target`), as the tab menu's does.
      openFolder: (path) => {
        api.openIn(s.repo, { worktree: path, path: 'root', line: null, opener: 'file-manager', source: null, fallback: null }).catch((e: unknown) => toast(errorMessage(e)));
      },
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

/** The sidebar payload of the tab showing repo `repo`, when loaded (menus read stores only). Any tab on the same `repo.id` is the same repo, so its payload is equally current: the first will do. */
const sidebarFor = (repo: number, active?: string): SidebarPayload | null => {
  const sb = Object.values(useRuntime.getState().tabs).find((t) => t.repo?.id === repo && t.sidebar)?.sidebar ?? null;
  // The first tab's payload is marked for ITS worktree: re-mark it for the asking tab's.
  return sb && active ? withActiveSidebar(sb, active) : sb;
};

/** `refs/remotes/<remote>/<branch>` split by the sidebar's remote names (a remote name may hold
 * "/"; the longest match wins), else at the first "/". */
export function splitRemoteRef(ref: string, remotes: readonly string[]): Upstream | null {
  const rest = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : null;
  if (!rest) return null;
  const known = [...remotes].sort((a, b) => b.length - a.length).find((r) => rest.startsWith(`${r}/`));
  const remote = known ?? rest.slice(0, Math.max(0, rest.indexOf('/')));
  return remote && rest.length > remote.length + 1 ? { remote, branch: rest.slice(remote.length + 1) } : null;
}

/** A local branch's configured upstream, from the sidebar: the upstream, `null` when it has none
 * (or its remote branch is gone), `undefined` when the sidebar doesn't know the branch (not
 * loaded yet): the caller then infers it. */
function configuredUpstream(sidebar: SidebarPayload | null, local: string): Upstream | null | undefined {
  const b = sidebar?.locals.find((x) => x.fullName === local);
  if (!sidebar || !b) return undefined;
  if (!b.upstream || b.gone) return null;
  return splitRemoteRef(b.upstream, sidebar.remotes.map((r) => r.name));
}

/**
 * The upstream of the branch `sha` is on (spec §7, the file menu's ⎇): the branches whose tip
 * it is (HEAD's first), else the branch it belongs to (the graph's first-parent membership,
 * F7). A local branch's is its configured upstream, from the sidebar (`sidebar`); a branch the
 * sidebar doesn't know (or no sidebar yet) is inferred as the same-named remote-tracking branch.
 * A remote-tracking branch is its own. Null when none is known.
 */
export function upstreamOf(g: GraphPayload, indexById: Map<string, number>, sha: string, sidebar: SidebarPayload | null = null): Upstream | null {
  const i = indexById.get(sha);
  if (i === undefined) return null;
  const { byRow, membership } = graphInfo(g);
  const labels = (byRow.get(i) ?? []).filter((l) => !l.tag).sort((a, b) => Number(b.isHead) - Number(a.isHead));
  for (const l of labels) {
    const cfg = l.local ? configuredUpstream(sidebar, l.local) : undefined;
    if (cfg) return cfg;
    // The sidebar knows this branch and it has no (or a gone) upstream: none, not a same-named guess.
    if (cfg === null) continue;
    const own = originFirst(l.remotes);
    if (own) return upstreamFrom(own);
    const up = l.local && cfg === undefined ? sameNamed(g, l.local.replace(/^refs\/heads\//, '')) : null;
    if (up) return up;
  }
  const m = membership[i];
  if (!m) return null;
  if (m.ref.startsWith('refs/heads/')) {
    const cfg = configuredUpstream(sidebar, m.ref);
    return cfg !== undefined ? cfg : sameNamed(g, m.ref.slice('refs/heads/'.length));
  }
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

/** K99: the folder a list's paths are relative to. A WIP/worktree list: that worktree. A commit
 * that is a checked-out worktree's HEAD (its branch label says where): that worktree. Else the
 * tab's open (active) worktree, never the main one from a linked tab (spec #2 §11.2). */
export function rootOfSpec(s: RepoViewState, spec: DiffSpec): string {
  if (spec.kind === 'wip' || spec.kind === 'worktree') return spec.worktree;
  if (spec.kind === 'commit') {
    const r = s.indexById.get(spec.id);
    const wt = r === undefined ? undefined : s.graph.labels.find((l) => l.row === r && l.worktree)?.worktree;
    if (wt) return wt;
    const open = openWorktree(s);
    return sidebarFor(s.repo)?.worktrees.find((w) => w.path !== open && w.head === spec.id)?.path ?? open;
  }
  return openWorktree(s);
}

/** The file menu's target for row `t` of the list for `spec`. */
export function fileTargetOf(s: RepoViewState, spec: DiffSpec, t: DiffTarget, changed: boolean): FileTarget {
  const inWorktree = spec.kind === 'wip' || spec.kind === 'worktree' ? spec.worktree : null;
  const root = inWorktree ?? worktreeOf(t) ?? rootOfSpec(s, spec);
  const deleted = t.new.kind === 'absent';
  const { sha, branch } = commitsOf(s, spec, t, deleted);
  return {
    path: t.path,
    root,
    sha,
    upstream: branch ? upstreamOf(s.graph, s.indexById, branch, sidebarFor(s.repo)) : null,
    diff: t,
    changed,
    deleted,
    list: spec.kind,
    openIn: { worktree: root, path: t.path, line: null, ...openVersion(t, inWorktree) },
    wip: spec.kind === 'wip'
      ? { worktree: spec.worktree, staged: spec.staged, oldPath: t.oldPath, status: t.status, submodule: s.services.wip.peek(wipKey(spec.worktree, spec.staged))?.files.find((f) => f.path === t.path)?.submodule === true }
      : null,
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
  const root = rootOfSpec(s, spec);
  return { path, root, openIn: { worktree: root, path: inside, line: null, source: null, fallback: null } };
}

/** A right-click on a folder row (tree mode). */
export function folderMenu(store: RepoViewStore, spec: DiffSpec, path: string, inside: string): () => MenuRow[] {
  afterOpening(store);
  return () => buildMenu<FolderTarget, MenuEnv>('folder', folderTargetOf(store.getState(), spec, path, inside), fileMenuEnv(store));
}

/** The row's primary branch: its first branch chip (HEAD's sorts first), as a right-click on that
 * chip would see it. A row with only tags, a detached HEAD or no labels has none. */
export function primaryBranchOf(s: RepoViewState, row: RowPayload): BranchRef | null {
  const labels = labelsByRowOf(s.graph.labels).get(s.indexById.get(row.id) ?? -1) ?? [];
  const l = labels.find((x) => !x.tag && (x.local !== null || x.remotes.length > 0));
  return l ? branchRefOf(l) : null;
}

/** A right-click on a graph row, or on a branch label chip (`branch` set): plan 1C Task 15. A row
 * with a branch gets that branch's chip menu (its primary branch, `primaryBranchOf`), which has
 * every commit row too; one without, the commit menu. WIP rows get no commit menu
 * (`commitTargetOf`'s `isWip`; the builders gate on it too). */
export function commitMenu(store: RepoViewStore, row: RowPayload, branch: BranchRef | null = null): () => MenuRow[] {
  afterOpening(store);
  return () => buildMenu<CommitTarget, MenuEnv>('commit', commitTargetOf(row, branch ?? primaryBranchOf(store.getState(), row)), fileMenuEnv(store));
}

// --- 3B T5: the selection's menu ---
/** Two or more selected commits (spec #3 §4.3), newest first: the `selection` kind's target. */
export interface SelectionTarget { commits: CommitRef[] }

/** A right-click on a graph row: inside a selection of two or more commits, the selection's menu
 * (the row's own when none of its rows applies); elsewhere, the row's commit menu. */
export function graphRowMenu(store: RepoViewStore, row: RowPayload): () => MenuRow[] {
  const own = commitMenu(store, row);
  if (!inCommitSelection(store.getState(), row.id)) return own;
  return () => {
    const rows = buildMenu<SelectionTarget, MenuEnv>('selection', { commits: selectedCommits(store.getState()) }, fileMenuEnv(store));
    return rows.length > 0 ? rows : own();
  };
}
// --- end 3B T5 ---

// --- 2C T9: the wip menu ---
/** A right-click on a WIP row (spec #2 §14): the `wip` kind. */
export function wipMenu(store: RepoViewStore, row: RowPayload): () => MenuRow[] {
  const wt = row.wip?.worktreePath ?? '';
  return () => {
    const env = fileMenuEnv(store);
    return buildMenu<WipTarget, MenuEnv>('wip', { worktree: wt, name: row.wip?.worktreeName ?? null, active: wt === env.activeWorktree }, env);
  };
}
// --- end 2C T9 ---

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
  return s.diff ? monacoTargetFor(s, s.diff, e) : null;
}

/** `monacoTargetOf` for an editor showing `diff` (the open file, or a center view's editor file),
 * in worktree `root` when given (else the one its list implies). Exported for its unit test. */
export function monacoTargetFor(s: RepoViewState, diff: DiffTarget, e: EditorContextMenuEvent, given?: string): MonacoTarget {
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
  const root = given ?? inWorktree ?? worktreeOf(diff) ?? (spec ? rootOfSpec(s, spec) : s.repoPath);
  return {
    path,
    sha,
    lines,
    selectionText: e.selectionText,
    upstream: branch ? upstreamOf(s.graph, s.indexById, branch, sidebarFor(s.repo)) : null,
    // The same version the file list's row would open (spec §14.5), at the clicked line.
    openIn: { worktree: root, path, line: lines[0], ...openVersion(diff, inWorktree) },
  };
}

/** The builder for `MonacoHost.setContextMenuHandler`'s callback (installed while a tab is
 * active, plan 1C Task 15). There's no DOM `contextmenu` event to build from (the editor's own
 * was already suppressed by the host), so the caller shows the rows itself: `const build =
 * monacoMenu(store, e, tabId); const rows = build(); if (rows.length) useMenu.getState().show(rows, e.x,
 * e.y, performance.now(), build);`. */
export function monacoMenu(store: RepoViewStore, e: EditorContextMenuEvent, tabId: string | null = tabIdOf(store)): () => MenuRow[] {
  afterOpening(store);
  return () => {
    // A center view on top in the tab (File History…): its own editor's file, never the one
    // hidden under it, and no staging rows (spec #3 §4.2's file is read-only).
    const s = store.getState();
    if (tabId !== null && centerViewOnTop(centerViewOf(tabId), s.diff)) {
      const file = centerViewEditorFile(tabId);
      return file ? buildMenu<MonacoTarget, MenuEnv>('monaco', monacoTargetFor(s, file.target, e, file.root), fileMenuEnv(store)) : [];
    }
    const t = monacoTargetOf(s, e);
    // A WIP diff's Stage/Unstage/Discard rows first (spec #2 §7.3), then Copy and the rest.
    return joinGroups(stagingRows(e), t ? buildMenu<MonacoTarget, MenuEnv>('monaco', t, fileMenuEnv(store)) : []);
  };
}

// Plan 1C Task 15b: the sidebar's item menus (spec §7's target table: branch, remote branch,
// remote, tag, stash, worktree). Read-only rows only; checkout, delete, push… are sub-project #2's.

/** Joins row groups with a separator between the non-empty ones. */
const joinGroups = (...groups: MenuRow[][]): MenuRow[] =>
  groups.filter((g) => g.length > 0).flatMap((g, i) => (i === 0 ? g : [{ kind: 'separator' as const }, ...g]));

/** A right-click (or the menu key) on a sidebar item. A local or remote branch gets the branch
 * label's commit menu (a local's remote copy is its configured upstream, from the sidebar), a tag
 * the tag menu, a stash and a worktree their own copy/open rows; each ends with "Show in graph". */
export function sidebarItemMenu(store: RepoViewStore, item: SideItem): () => MenuRow[] {
  afterOpening(store);
  return () => {
    const s = store.getState();
    const env = fileMenuEnv(store);
    const view = (target: SidebarTarget) => buildMenu<SidebarTarget, MenuEnv>('sidebar', target, env);
    const sha = item.target;
    switch (item.kind) {
      case 'local': case 'remote': {
        const sidebar = sidebarFor(s.repo);
        const upstream = item.kind === 'local' && item.branch.upstream && !item.branch.gone ? splitRemoteRef(item.branch.upstream, sidebar?.remotes.map((r) => r.name) ?? []) : null;
        const branch: BranchRef = item.kind === 'local'
          ? { name: item.name, local: item.branch.fullName, remotes: upstream ? [{ fullName: item.branch.upstream!, remote: upstream.remote }] : [] }
          : { name: `${item.remote}/${item.name}`, local: null, remotes: [{ fullName: item.branch.fullName, remote: item.remote }] };
        const mrRefs = sha ? s.graph.rows[s.indexById.get(sha) ?? -1]?.mrRefs ?? [] : [];
        return joinGroups(sha ? buildMenu<CommitTarget, MenuEnv>('commit', { sha, mrRefs, isWip: false, isStash: false, branch }, env) : [], view({ what: 'ref', sha }));
      }
      case 'tag':
        return joinGroups(sha ? buildMenu<TagTarget, MenuEnv>('tag', { name: item.tag.name, fullName: item.tag.fullName, sha }, env) : [], view({ what: 'ref', sha }));
      case 'stash':
        return view({ what: 'stash', sha: item.stash.id, message: item.stash.message });
      case 'worktree':
        return view({ what: 'worktree', path: item.worktree.path, branch: item.worktree.branch, head: item.worktree.head });
    }
  };
}

/** A right-click on a remote's folder row in the Remote panel. */
export function sidebarRemoteMenu(store: RepoViewStore, remote: string): () => MenuRow[] {
  afterOpening(store);
  return () => {
    const url = Object.values(useRuntime.getState().tabs).find((t) => t.repo?.id === store.getState().repo)?.info?.remotes.find((r) => r.name === remote)?.url ?? null;
    return buildMenu<SidebarTarget, MenuEnv>('sidebar', { what: 'remote', name: remote, url }, fileMenuEnv(store));
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
