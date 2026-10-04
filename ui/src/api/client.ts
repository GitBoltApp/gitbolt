import type { AvatarPayload } from './gen/AvatarPayload';
import type { BlobSource } from './gen/BlobSource';
import type { CommandLogEntry } from './gen/CommandLogEntry';
import type { CommitDetailsPayload } from './gen/CommitDetailsPayload';
import type { CommitMessage } from './gen/CommitMessage';
import type { DiffContentsPayload } from './gen/DiffContentsPayload';
import type { DiffSpec } from './gen/DiffSpec';
import type { FileListPayload } from './gen/FileListPayload';
import type { GraphPayload } from './gen/GraphPayload';
import type { HexDumpPayload } from './gen/HexDumpPayload';
import type { HistoryHit } from './gen/HistoryHit';
import type { LocateResult } from './gen/LocateResult';
import type { OpenerPayload } from './gen/OpenerPayload';
import type { RemotePayload } from './gen/RemotePayload';
import type { RepoSummary } from './gen/RepoSummary';
import type { SignaturePayload } from './gen/SignaturePayload';
import type { AppEvent } from './gen/AppEvent';
import type { AppInfoPayload } from './gen/AppInfoPayload';
import type { AppSettings } from './gen/AppSettings';
import type { FrontendLevel } from './gen/FrontendLevel';
import type { UiDiagnostics } from './gen/UiDiagnostics';
import type { FetchOutcome } from './gen/FetchOutcome';
import type { LastPushPayload } from './gen/LastPushPayload';
import type { PinSetting } from './gen/PinSetting';
import type { Profile } from './gen/Profile';
import type { ProfileMeta } from './gen/ProfileMeta';
import type { RepoInfoPayload } from './gen/RepoInfoPayload';
import type { Request } from './gen/Request';
import type { SaveOutcome } from './gen/SaveOutcome';
import type { ScannedRepo } from './gen/ScannedRepo';
import type { SequenceOutcome } from './gen/SequenceOutcome';
import type { QueueStatePayload } from './gen/QueueStatePayload';
import type { JournalState } from './gen/JournalState';
import type { HistoryRow } from './gen/HistoryRow';
import type { IntegrateOutcome } from './gen/IntegrateOutcome';
// --- 2D T19 ---
import type { PullMode } from './gen/PullMode';
import type { PullOutcome } from './gen/PullOutcome';
// --- end 2D T19 ---
import type { RebaseAction } from './gen/RebaseAction';
import type { PickOutcome } from './gen/PickOutcome';
import type { CommitIdentity } from './gen/CommitIdentity';
import type { UndoOutcome } from './gen/UndoOutcome';
import type { CommitOutcome } from './gen/CommitOutcome';
import type { Expect } from './gen/Expect';
import type { RebasePlanPayload } from './gen/RebasePlanPayload';
import type { RebaseRow } from './gen/RebaseRow';
import type { ChipPlan } from './gen/ChipPlan';
import type { Prediction } from './gen/Prediction';
// --- 2C T12 ---
import type { CheckoutOutcome } from './gen/CheckoutOutcome';
import type { CheckoutTarget } from './gen/CheckoutTarget';
import type { OnDiverged } from './gen/OnDiverged';
import type { ResetMode } from './gen/ResetMode';
// --- end 2C T12 ---
import type { IntegrateKind } from './gen/IntegrateKind';
import type { IntegratePreviewPayload } from './gen/IntegratePreviewPayload';
import type { WriteResult } from './gen/WriteResult';
import type { StashApplyOutcome } from './gen/StashApplyOutcome';
import type { StashPushOutcome } from './gen/StashPushOutcome';
import type { StagingUndoState } from './gen/StagingUndoState';
// --- 2B T3 ---
import type { HunksPayload } from './gen/HunksPayload';
import type { StageSelection } from './gen/StageSelection';
import type { WipBase } from './gen/WipBase';
// --- end 2B T3 ---
// --- 2B T4 ---
import type { DiscardScope } from './gen/DiscardScope';
// --- end 2B T4 ---
// --- 2B T10 ---
import type { SelectionLines } from './gen/SelectionLines';
// --- end 2B T10 ---
import type { SidebarPayload } from './gen/SidebarPayload';
import type { StatePayload } from './gen/StatePayload';
// --- 2C T14 ---
import type { WorktreeAdded } from './gen/WorktreeAdded';
import type { WorktreeBranch } from './gen/WorktreeBranch';
import type { WorktreeRemoveOutcome } from './gen/WorktreeRemoveOutcome';
// --- end 2C T14 ---
// --- 2C T11 ---
import type { UpstreamTarget } from './gen/UpstreamTarget';
import type { RemoteBranchRef } from './gen/RemoteBranchRef';
import type { DeleteOutcome } from './gen/DeleteOutcome';
// --- end 2C T11 ---
// --- 2D T15 ---
import type { Resolution } from './gen/Resolution';
import type { SubmoduleBehind } from './gen/SubmoduleBehind';
// --- end 2D T15 ---
import { createTransport, deliver, type EventHandler, type Transport } from './transport';
// --- 2D T17 ---
import type { Lease } from './gen/Lease';
import type { PushOutcome } from './gen/PushOutcome';
import type { PushTarget } from './gen/PushTarget';
// --- end 2D T17 ---
// --- 2D T20 ---
import type { ConflictFilePayload } from './gen/ConflictFilePayload';
import type { BlamePayload } from './gen/BlamePayload';
import type { FileHistoryPage } from './gen/FileHistoryPage';
import type { TagPushOutcome } from './gen/TagPushOutcome';
// --- end 2D T20 ---

const handlers = new Set<EventHandler>();
let transport: Transport | undefined;
const dispatch = (ev: AppEvent) => { deliver(handlers, ev); };
/** How long after the harness socket drops a listener reconnects it. */
export const RECONNECT_MS = 500;
const t = (): Transport => {
  if (!transport) {
    transport = createTransport(() => {
      transport = undefined;
      // Keep receiving events after the harness socket drops: reconnect while anyone listens.
      if (handlers.size > 0) setTimeout(() => { t(); }, RECONNECT_MS);
    });
    transport.subscribe(dispatch);
  }
  return transport;
};

/** Subscribe to backend events (spec §4.3). Survives transport reconnects. */
export function onEvent(h: EventHandler): () => void {
  handlers.add(h);
  t();
  return () => { handlers.delete(h); };
}

/** One request, typed by the generated `Request`; `T` is its response. */
const call = <T>(req: Request) => t().call(req) as Promise<T>;

/** One `diffContents` request: the two sides the file list built, sent back unchanged. */
export interface ContentsRequest { path: string; old: BlobSource; new: BlobSource; force: boolean }
/** One "Open in…" request: `path` relative to `worktree` (one of the repo's), at `line` (1-based). */
export interface OpenInRequest { worktree: string; path: string; line: number | null; opener: string; source: BlobSource | null; fallback: BlobSource | null }

export const api = {
  openRepo: (path: string) => t().call({ method: 'openRepo', params: { path } }) as Promise<RepoSummary>,
  /** `extra`: the pinned trunk (spec §8.2), `rescan` to re-read the WIP status, and the tab's
   * `active` worktree (spec #2 §11.2), laid out as the open one. */
  graph: (repo: number, limit: number | null = null, extra: { pin?: PinSetting; rescan?: boolean; active?: string } = {}) =>
    call<GraphPayload>({ method: 'graph', params: { repo, limit, ...extra } }),
  commandLog: () => t().call({ method: 'commandLog' }) as Promise<CommandLogEntry[]>,
  launchRepo: () => t().call({ method: 'launchRepo' }) as Promise<string | null>,
  /** Paths later launches forwarded (the single-instance guard) not yet taken: each returned once. */
  takeOpenRequests: () => call<string[]>({ method: 'takeOpenRequests' }),
  /** One commit's full message (summary + body), loaded on demand: see `commitMessages.ts`. */
  commitMessage: (repo: number, id: string) => t().call({ method: 'commitMessage', params: { repo, id } }) as Promise<CommitMessage>,
  /** The details panel's header (§9.1); the message comes from `commitMessage`. */
  commitDetails: (repo: number, id: string) => t().call({ method: 'commitDetails', params: { repo, id } }) as Promise<CommitDetailsPayload>,
  remotes: (repo: number) => t().call({ method: 'remotes', params: { repo } }) as Promise<RemotePayload[]>,
  fileList: (repo: number, spec: DiffSpec) => t().call({ method: 'fileList', params: { repo, spec } }) as Promise<FileListPayload>,
  diffContents: (repo: number, r: ContentsRequest) => t().call({ method: 'diffContents', params: { repo, path: r.path, old: r.old, new: r.new, force: r.force } }) as Promise<DiffContentsPayload>,
  /** Both sides of a binary file as hex dumps, each capped (`HexDumpPayload.cap`). */
  hexDump: (repo: number, r: Omit<ContentsRequest, 'force'>) => t().call({ method: 'hexDump', params: { repo, path: r.path, old: r.old, new: r.new } }) as Promise<HexDumpPayload>,
  treeFiles: (repo: number, id: string) => t().call({ method: 'treeFiles', params: { repo, id } }) as Promise<string[]>,
  /** UX G.2: the worktree's tracked files (the WIP row's View all files). */
  worktreeFiles: (repo: number, worktree: string) => t().call({ method: 'worktreeFiles', params: { repo, worktree } }) as Promise<string[]>,
  signature: (repo: number, id: string) => t().call({ method: 'signature', params: { repo, id } }) as Promise<SignaturePayload>,
  /** `null` when there's no avatar for `email` (or no avatar provider, as in the harness). */
  avatar: (email: string) => t().call({ method: 'avatar', params: { email } }) as Promise<AvatarPayload | null>,
  openUrl: (url: string) => t().call({ method: 'openUrl', params: { url } }) as Promise<null>,
  /** The external editors and the file manager found on this machine (spec §14.5). */
  /** `repo`: the list as that repository sees it (its Custom editor, if its setting is one). */
  listOpeners: (repo?: number) => t().call(repo === undefined ? { method: 'listOpeners' } : { method: 'listOpenersFor', params: { repo } }) as Promise<OpenerPayload[]>,
  /** Checks a custom editor template; rejects with the guard's message when it would be refused. */
  validateEditorTemplate: (template: string) => t().call({ method: 'validateEditorTemplate', params: { template } }) as Promise<null>,
  openIn: (repo: number, r: OpenInRequest) => t().call({ method: 'openIn', params: { repo, worktree: r.worktree, path: r.path, line: r.line, opener: r.opener, source: r.source, fallback: r.fallback } }) as Promise<null>,
  // Plan 1C: settings and profiles (spec §14.1).
  loadState: () => call<StatePayload>({ method: 'loadState' }),
  saveSettings: (settings: AppSettings) => call<null>({ method: 'saveSettings', params: { settings } }),
  saveProfile: (profile: Profile) => call<null>({ method: 'saveProfile', params: { profile } }),
  createProfile: (name: string, color: string) => call<ProfileMeta>({ method: 'createProfile', params: { name, color } }),
  switchProfile: (id: string) => call<StatePayload>({ method: 'switchProfile', params: { id } }),
  deleteProfile: (id: string) => call<ProfileMeta[]>({ method: 'deleteProfile', params: { id } }),
  /** Starts the file watcher for the active tab's repo (spec §4.4); idempotent. */
  watchRepo: (repo: number) => t().call({ method: 'watchRepo', params: { repo } }) as Promise<null>,
  unwatchRepo: (repo: number) => t().call({ method: 'unwatchRepo', params: { repo } }) as Promise<null>,
  /** Stops every watcher: the startup reset, so none outlive a reload. */
  unwatchAll: () => t().call({ method: 'unwatchAll' }) as Promise<null>,
  repoInfo: (repo: number) => call<RepoInfoPayload>({ method: 'repoInfo', params: { repo } }),
  sidebar: (repo: number) => call<SidebarPayload>({ method: 'sidebar', params: { repo } }),
  lastPush: (repo: number, remoteRef: string) => call<LastPushPayload | null>({ method: 'lastPush', params: { repo, remoteRef } }),
  appInfo: () => call<AppInfoPayload>({ method: 'appInfo' }),
  pickFolder: (start: string | null) => call<string | null>({ method: 'pickFolder', params: { start } }),
  scanRepos: (root: string, refresh: boolean) => call<ScannedRepo[]>({ method: 'scanRepos', params: { root, refresh } }),
  /** The repos in every folder, scanned in parallel, merged and de-duplicated ("Your repos"). */
  scanFolders: (roots: string[], refresh: boolean) => call<ScannedRepo[]>({ method: 'scanFolders', params: { roots, refresh } }),
  /** Clones `url` into the absolute `dest` (spec §13); the op's label is `dest`. */
  clone: (url: string, dest: string) => call<RepoSummary>({ method: 'clone', params: { url, dest } }),
  suggestReposFolder: () => call<string | null>({ method: 'suggestReposFolder' }),
  /** `git fetch --all` (spec §15). `background`: GitBolt's own timer, which never prompts. */
  fetch: (repo: number, background: boolean) => call<FetchOutcome>({ method: 'fetch', params: { repo, background } }),
  /** The action queue (spec #2 §3.6). */
  queueState: (repo: number) => call<QueueStatePayload>({ method: 'queueState', params: { repo } }),
  queueRemove: (repo: number, id: number) => call<boolean>({ method: 'queueRemove', params: { repo, id } }),
  queueResume: (repo: number) => call<null>({ method: 'queueResume', params: { repo } }),
  queueClear: (repo: number) => call<null>({ method: 'queueClear', params: { repo } }),
  /** Ends a running network op (its git process group); it finishes as `cancelled`. */
  cancelOp: (op: number) => call<null>({ method: 'cancelOp', params: { op } }),
  /** The answer to an askpass prompt (spec §5.4); `null` cancels it. */
  authAnswer: (prompt: number, answer: string | null) => call<null>({ method: 'authAnswer', params: { prompt, answer } }),
  // Plan 1C Task 17: find (spec §8.7), over the last `graph` window.
  findText: (repo: number, query: string) => call<string[]>({ method: 'findText', params: { repo, query } }),
  findPaths: (repo: number, query: string) => call<string[]>({ method: 'findPaths', params: { repo, query } }),
  locateCommit: (repo: number, sha: string) => call<LocateResult>({ method: 'locateCommit', params: { repo, sha } }),
  searchHistory: (repo: number, query: string) => call<HistoryHit[]>({ method: 'searchHistory', params: { repo, query } }),
  // Plan 1D Task 7/9: log files, frontend errors, diagnostics.
  logFrontend: (level: FrontendLevel, message: string, stack: string | null) => call<null>({ method: 'logFrontend', params: { level, message, stack } }),
  setDebugLogging: (debug: boolean) => call<null>({ method: 'setDebugLogging', params: { debug } }),
  /** The log directory, or `null` where there is no file logging (the harness). */
  logsDir: () => call<string | null>({ method: 'logsDir' }),
  diagnostics: (ui: UiDiagnostics) => call<string>({ method: 'diagnostics', params: { ui } }),
  openLogsFolder: () => call<null>({ method: 'openLogsFolder' }),
  // Plan 2A: the write foundation (spec #2 §3–§6).
  /** Remove stale lock (spec #2 §14): only if `path`'s mtime is still `mtimeMs`. */
  removeIndexLock: (repo: number, lock: { path: string; mtimeMs: number; ino: number; dev: number }) => call<null>({ method: 'removeIndexLock', params: { repo, ...lock } }),
  journalState: (repo: number, worktree: string) => call<JournalState>({ method: 'journalState', params: { repo, worktree } }),
  /** Undo `entry`, the toolbar's (spec #2 §5.4); `confirm`: "Undo anyway", the refs as the prompt
   * showed them; `confirmAutostash`: the clean-restore warning (§6.2) was confirmed. */
  // --- 2C T7: `withoutIndex`, "Apply without restoring what was staged?" (a stash's undo/redo) ---
  // 3B T6: `confirmDiscard`, "Undo the stopped cherry-pick?" (`undoStoppedPick`) was confirmed.
  undo: (repo: number, worktree: string, entry: number, confirm: Record<string, string | null> | undefined, confirmAutostash: boolean, withoutIndex = false, confirmDiscard = false) =>
    call<WriteResult<UndoOutcome>>({ method: 'undo', params: { repo, worktree, entry, ...(confirm && { confirm }), confirmAutostash, ...(withoutIndex && { withoutIndex }), ...(confirmDiscard && { confirmDiscard }) } }),
  redo: (repo: number, worktree: string, entry: number, confirmAutostash: boolean, withoutIndex = false) =>
    call<WriteResult<UndoOutcome>>({ method: 'redo', params: { repo, worktree, entry, confirmAutostash, ...(withoutIndex && { withoutIndex }) } }),
  // --- end 2C T7 ---
  // --- UX Y ---
  /** The Undo dropdown's row `entry` (`JournalState.history`): an older one is undone out of
   * order, as an entry of its own, when it's independent of every later one. */
  undoEntry: (repo: number, worktree: string, entry: number, confirmAutostash: boolean) =>
    call<WriteResult<UndoOutcome>>({ method: 'undoEntry', params: { repo, worktree, entry, confirmAutostash } }),
  /** The Undo dropdown's rows, read when it opens. */
  journalHistory: (repo: number, worktree: string) => call<HistoryRow[]>({ method: 'journalHistory', params: { repo, worktree } }),
  // --- end UX Y ---
  /** A banner's Apply / Restore (spec #2 §6.4); `withoutIndex` after "Apply without restoring
   * what was staged?"; `confirmAutostash`: a Restore's clean-restore warning was confirmed. */
  applyKeptStash: (repo: number, worktree: string, entry: number, withoutIndex: boolean, confirmAutostash: boolean) =>
    call<WriteResult<null>>({ method: 'applyKeptStash', params: { repo, worktree, entry, withoutIndex, confirmAutostash } }),
  /** A banner's × (`dropStash: false`, the stash stays) or Drop stash. */
  dismissBanner: (repo: number, worktree: string, entry: number, dropStash: boolean) => call<JournalState>({ method: 'dismissBanner', params: { repo, worktree, entry, dropStash } }),
  // --- 2B T6 ---
  /** Plan 2B T6, UX round 2 G.2: save the editable working copy (spec #2 §7.5). Journaled: Undo
   * puts the file back as it was. */
  writeWorktreeFile: (repo: number, worktree: string, path: string, text: string, base: string) =>
    call<WriteResult<SaveOutcome>>({ method: 'writeWorktreeFile', params: { repo, worktree, path, text, base } }),
  /** UX round 3 O.1: a new, empty file (its folders made); journaled, so Undo removes it. */
  createWorktreeFile: (repo: number, worktree: string, path: string) =>
    call<WriteResult<SaveOutcome>>({ method: 'createWorktreeFile', params: { repo, worktree, path } }),
  // --- end 2B T6 ---
  // Plan 2B T1: stage and unstage (spec #2 §7.2). Immediate writes; not journaled.
  stage: (repo: number, worktree: string, paths: string[]) => call<WriteResult<null>>({ method: 'stage', params: { repo, worktree, paths } }),
  /** `oldPaths`: a rename's sources, unstaged with it. */
  unstage: (repo: number, worktree: string, paths: string[], oldPaths: string[] = []) => call<WriteResult<null>>({ method: 'unstage', params: { repo, worktree, paths, oldPaths } }),
  stageAll: (repo: number, worktree: string) => call<WriteResult<null>>({ method: 'stageAll', params: { repo, worktree } }),
  unstageAll: (repo: number, worktree: string) => call<WriteResult<null>>({ method: 'unstageAll', params: { repo, worktree } }),
  // --- 2B T2 ---
  // Plan 2B T2: the staging undo log (spec #2 §7.6).
  stagingUndo: (repo: number, worktree: string) => call<WriteResult<null>>({ method: 'stagingUndo', params: { repo, worktree } }),
  stagingRedo: (repo: number, worktree: string) => call<WriteResult<null>>({ method: 'stagingRedo', params: { repo, worktree } }),
  stagingState: (repo: number, worktree: string) => call<StagingUndoState>({ method: 'stagingState', params: { repo, worktree } }),
  // --- end 2B T2 ---
  // Plan 2B T5: commit (spec #2 §8). Queued; hooks and signing are git's.
  commit: (repo: number, worktree: string, r: { summary: string; description: string; amend: boolean; stageAll: boolean; expect: Expect }) =>
    call<WriteResult<CommitOutcome>>({ method: 'commit', params: { repo, worktree, ...r } }),
  editHeadMessage: (repo: number, worktree: string, message: string, expect: Expect) => call<WriteResult<CommitOutcome>>({ method: 'editHeadMessage', params: { repo, worktree, message, expect } }),
  /** The upstream's short name when HEAD is on it (the pencil's force-push note), else null. */
  headOnUpstream: (repo: number, worktree: string) => call<string | null>({ method: 'headOnUpstream', params: { repo, worktree } }),
  // --- end Plan 2B T5 ---
  // --- 2B T3 ---
  // Plan 2B T3: hunks and lines (spec #2 §7.3).
  wipHunks: (repo: number, worktree: string, path: string, staged: boolean) => call<HunksPayload>({ method: 'wipHunks', params: { repo, worktree, path, staged } }),
  stagePatch: (repo: number, worktree: string, r: { path: string; staged: boolean; selection: StageSelection; base: WipBase }) =>
    call<WriteResult<null>>({ method: 'stagePatch', params: { repo, worktree, ...r } }),
  // --- end 2B T3 ---
  // --- 2B T4 ---
  // Plan 2B T4: discards (spec #2 §7.2–§7.4). Journaled; Undo restores the snapshot.
  discard: (repo: number, worktree: string, scope: DiscardScope) => call<WriteResult<null>>({ method: 'discard', params: { repo, worktree, scope } }),
  // --- end 2B T4 ---
  // --- 2B T10 ---
  /** The line bar's counts (spec #2 §7.3), after the no-newline tie; read-only. */
  selectionLines: (repo: number, worktree: string, path: string, staged: boolean, selection: StageSelection) =>
    call<SelectionLines>({ method: 'selectionLines', params: { repo, worktree, path, staged, selection } }),
  // --- end 2B T10 ---
  // --- 2C T14: worktrees ---
  worktreeAdd: (repo: number, worktree: string, path: string, branch: WorktreeBranch) => call<WriteResult<WorktreeAdded>>({ method: 'worktreeAdd', params: { repo, worktree, path, branch } }),
  worktreeRemove: (repo: number, worktree: string, path: string, force: boolean) => call<WriteResult<WorktreeRemoveOutcome>>({ method: 'worktreeRemove', params: { repo, worktree, path, force } }),
  /** The create dialog's default folder (spec #2 §11.1). */
  suggestWorktreePath: (repo: number, branch: string) => call<string>({ method: 'suggestWorktreePath', params: { repo, branch } }),
  // --- end 2C T14 ---
  // --- 2C T11: branches ---
  /** Create branch here / the toolbar Branch (spec #2 §9.1). */
  createBranch: (repo: number, worktree: string, b: { name: string; start: string; startRef: string | null; checkout: boolean; expect: Expect }, confirmAutostash: boolean) =>
    call<WriteResult<null>>({ method: 'createBranch', params: { repo, worktree, name: b.name, start: b.start, startRef: b.startRef ?? undefined, checkout: b.checkout, expect: b.expect, confirmAutostash } }),
  renameBranch: (repo: number, worktree: string, from: string, to: string, expect: Expect) => call<WriteResult<null>>({ method: 'renameBranch', params: { repo, worktree, from, to, expect } }),
  setUpstream: (repo: number, worktree: string, branch: string, upstream: UpstreamTarget | null) => call<WriteResult<null>>({ method: 'setUpstream', params: { repo, worktree, branch, upstream } }),
  /** `Delete | Local | Remote | Both |` (spec #2 §9.2). */
  deleteBranch: (repo: number, worktree: string, d: { branch: string; local: boolean; remote: RemoteBranchRef | null; force: boolean; expect: Expect }) =>
    call<WriteResult<DeleteOutcome>>({ method: 'deleteBranch', params: { repo, worktree, ...d } }),
  // --- end 2C T11 ---
  // --- 2C T13 ---
  /** Stash (spec #2 §10): `message` is the WIP draft, '' for the branch-based name. */
  stashPush: (repo: number, worktree: string, message: string) => call<WriteResult<StashPushOutcome>>({ method: 'stashPush', params: { repo, worktree, message } }),
  stashApply: (repo: number, worktree: string, oid: string, pop: boolean, withoutIndex: boolean) =>
    call<WriteResult<StashApplyOutcome>>({ method: 'stashApply', params: { repo, worktree, oid, pop, withoutIndex } }),
  stashDrop: (repo: number, worktree: string, oid: string) => call<WriteResult<null>>({ method: 'stashDrop', params: { repo, worktree, oid } }),
  // --- end 2C T13 ---
  // --- 2D T15 ---
  /** Resolve a conflicted file (spec #2 §13.3). `base`: `conflictFile`'s hash, for a text save. */
  resolveFile: (repo: number, worktree: string, path: string, resolution: Resolution, base: string | undefined, confirmMarkers: boolean, confirmDiscard: boolean) =>
    call<WriteResult<SubmoduleBehind | null>>({ method: 'resolveFile', params: { repo, worktree, path, resolution, base, confirmMarkers, confirmDiscard } }),
  // --- end 2D T15 ---
  // --- 2D T16 ---
  /** Continue, skip or abort a paused rebase. `message`: Continue commits the stopped pick with it. */
  rebaseControl: (repo: number, worktree: string, action: RebaseAction, message?: string) => call<WriteResult<IntegrateOutcome>>({ method: 'rebaseControl', params: { repo, worktree, action, message } }),
  /** The same for a cherry-pick or revert in progress (ux round 1). */
  pickControl: (repo: number, worktree: string, action: RebaseAction, message?: string) => call<WriteResult<PickOutcome>>({ method: 'pickControl', params: { repo, worktree, action, message } }),
  /** Who a commit in `worktree` is made as (git's resolution); `null`: git has no identity. */
  commitIdentity: (repo: number, worktree: string) => call<CommitIdentity | null>({ method: 'commitIdentity', params: { repo, worktree } }),
  mergeAbort: (repo: number, worktree: string) => call<WriteResult<IntegrateOutcome>>({ method: 'mergeAbort', params: { repo, worktree } }),
  /** A paused merge or rebase ended outside GitBolt: close its journal entry. */
  settlePaused: (repo: number, worktree: string) => call<WriteResult<null>>({ method: 'settlePaused', params: { repo, worktree } }),
  // --- end 2D T16 ---
  // --- 2D T17 ---
  /** Push `branch` (spec #2 §12.3): `target` + `setUpstream` for a branch with no upstream; `lease` forces. */
  push: (repo: number, worktree: string, branch: string, opts: { target?: PushTarget; setUpstream?: boolean; lease?: Lease; expect?: Expect } = {}) =>
    call<WriteResult<PushOutcome>>({ method: 'push', params: { repo, worktree, branch, ...opts, expect: opts.expect ?? { head: null, refs: {} } } }),
  // --- end 2D T17 ---
  // --- 2D T18 ---
  /** Merge or rebase HEAD's branch with `target` (spec #2 §13.1). `updateRefs` is explicit for a rebase. */
  integrate: (repo: number, worktree: string, kind: IntegrateKind, target: string, opts: { updateRefs?: boolean; confirmAutostash?: boolean; expect?: Expect } = {}) =>
    call<WriteResult<IntegrateOutcome>>({ method: 'integrate', params: { repo, worktree, kind, target, updateRefs: opts.updateRefs, expect: opts.expect ?? NO_EXPECT, confirm: { autostash: opts.confirmAutostash ?? false } } }),
  integratePreview: (repo: number, worktree: string, kind: IntegrateKind, target: string) => call<IntegratePreviewPayload>({ method: 'integratePreview', params: { repo, worktree, kind, target } }),
  fastForward: (repo: number, worktree: string, branch: string, to: string) => call<WriteResult<IntegrateOutcome>>({ method: 'fastForward', params: { repo, worktree, branch, to, expect: NO_EXPECT } }),
  // --- end 2D T18 ---
  // --- 2D T19 ---
  /** Pull (spec #2 §12.2); `branch` defaults to HEAD's. */
  pull: (repo: number, worktree: string, mode: PullMode, opts: { branch?: string; confirmAutostash?: boolean } = {}) =>
    call<WriteResult<PullOutcome>>({ method: 'pull', params: { repo, worktree, mode, branch: opts.branch, expect: NO_EXPECT, confirm: { autostash: opts.confirmAutostash ?? false } } }),
  // --- end 2D T19 ---
  // --- 2C T12 ---
  /** Checkout (spec #2 §9.3); `onDiverged: 'reset'` after the diverged dialog's Reset. */
  checkout: (repo: number, worktree: string, target: CheckoutTarget, expect: Expect, confirmAutostash: boolean, onDiverged?: OnDiverged) =>
    call<WriteResult<CheckoutOutcome>>({ method: 'checkout', params: { repo, worktree, target, expect, confirmAutostash, ...(onDiverged && { onDiverged }) } }),
  /** Reset X to this commit (spec #2 §9.4); `discard` after "discard changes to N files?". */
  reset: (repo: number, worktree: string, to: string, mode: ResetMode, expect: Expect, discard: boolean) =>
    call<WriteResult<null>>({ method: 'reset', params: { repo, worktree, to, mode, expect, discard } }),
  // --- end 2C T12 ---
  // --- 2D T20 ---
  /** The merge tool's data for one conflicted file (spec #2 §13.3); `null` once it isn't conflicted. */
  conflictFile: (repo: number, worktree: string, path: string) => call<ConflictFilePayload | null>({ method: 'conflictFile', params: { repo, worktree, path } }),
  // --- end 2D T20 ---
  // --- 3A T2 ---
  /** One page of `path`'s history from `rev` (null: the worktree's HEAD), newest first (spec #3 §3.10). */
  fileHistory: (repo: number, worktree: string, path: string, rev: string | null, skip: number, limit: number) =>
    call<FileHistoryPage>({ method: 'fileHistory', params: { repo, worktree, path, rev: rev ?? undefined, skip, limit } }),
  /** `path` at `rev`, line by line (spec #3 §3.10). */
  blame: (repo: number, worktree: string, rev: string, path: string) => call<BlamePayload>({ method: 'blame', params: { repo, worktree, rev, path } }),
  // --- end 3A T2 ---
  // --- 3A T3 ---
  /** Restore `path` as in `sha` into the working tree, unstaged (spec #3 §3.8); `confirm` after "replace your changes?". */
  restoreFile: (repo: number, worktree: string, sha: string, path: string, confirm: boolean) =>
    call<WriteResult<null>>({ method: 'restoreFile', params: { repo, worktree, sha, path, confirm } }),
  // --- end 3A T3 ---
  // --- 3B T7: tags ---
  /** Create tag here (spec #3 §3.9): `message` null for a lightweight tag. */
  createTag: (repo: number, worktree: string, t: { name: string; target: string; message: string | null }) =>
    call<WriteResult<null>>({ method: 'createTag', params: { repo, worktree, name: t.name, target: t.target, message: t.message ?? undefined } }),
  /** `Delete | Local | Remote | Both |` on a tag. */
  deleteTag: (repo: number, worktree: string, d: { name: string; local: boolean; remote: string | null }) =>
    call<WriteResult<null>>({ method: 'deleteTag', params: { repo, worktree, name: d.name, local: d.local, remote: d.remote ?? undefined } }),
  /** Push one tag, or every tag (`tag` null), to `remote`. */
  pushTags: (repo: number, worktree: string, remote: string, tag: string | null) =>
    call<WriteResult<TagPushOutcome>>({ method: 'pushTags', params: { repo, worktree, remote, tag: tag ?? undefined } }),
  // --- end 3B T7 ---
  // --- 3C T9 ---
  /** The interactive rebase editor's plan (spec #3 §3.3): `branch`'s commits since `base`, its chips, the tips it expects. */
  rebasePlan: (repo: number, worktree: string, branch: string, base: string) => call<RebasePlanPayload>({ method: 'rebasePlan', params: { repo, worktree, branch, base } }),
  // --- end 3C T9 ---
  // --- 3C T10 ---
  /** Start the interactive rebase (spec #3 §3.3): rows newest first; `expect` from the plan. */
  interactiveRebase: (repo: number, worktree: string, req: { branch: string; base: string; expect: Record<string, string>; rows: RebaseRow[]; chips: ChipPlan[]; confirmAutostash?: boolean }) =>
    call<WriteResult<IntegrateOutcome>>({ method: 'interactiveRebase', params: { repo, worktree, branch: req.branch, base: req.base, expect: req.expect, rows: req.rows, chips: req.chips, confirm: { autostash: req.confirmAutostash ?? false } } }),
  /** Conflict prediction for a plan (spec #3 §3.2; a read). */
  predictRebase: (repo: number, worktree: string, base: string, rows: RebaseRow[]) => call<Prediction>({ method: 'predictRebase', params: { repo, worktree, base, rows } }),
  // --- end 3C T10 ---
  // --- 3C T13 ---
  /** Reword an older commit of HEAD's branch in place (spec #3 §3.6); `confirmAutostash` after the clean-restore question. */
  rewordCommit: (repo: number, worktree: string, oid: string, message: string, expect: Expect, confirmAutostash = false) =>
    call<WriteResult<IntegrateOutcome>>({ method: 'rewordCommit', params: { repo, worktree, oid, message, expect, confirm: { autostash: confirmAutostash } } }),
  // --- end 3C T13 ---
  // --- 3B T6: cherry-pick and revert ---
  /** Cherry-pick `oids` (newest first, as the graph lists them) onto HEAD's branch, oldest first (spec #3 §3.7). */
  cherryPick: (repo: number, worktree: string, oids: string[], opts: { noCommit: boolean; confirmAutostash?: boolean; expect?: Expect }) =>
    call<WriteResult<SequenceOutcome>>({ method: 'cherryPick', params: { repo, worktree, oids, noCommit: opts.noCommit, expect: opts.expect ?? NO_EXPECT, confirm: { autostash: opts.confirmAutostash ?? false } } }),
  /** Revert `oids` (newest first) on HEAD's branch, newest first. */
  revert: (repo: number, worktree: string, oids: string[], opts: { noCommit: boolean; confirmAutostash?: boolean; expect?: Expect }) =>
    call<WriteResult<SequenceOutcome>>({ method: 'revert', params: { repo, worktree, oids, noCommit: opts.noCommit, expect: opts.expect ?? NO_EXPECT, confirm: { autostash: opts.confirmAutostash ?? false } } }),
  // --- end 3B T6 ---
};

// --- 2D T18 ---
/** `Expect` with nothing to check (the backend's own default). */
const NO_EXPECT: Expect = { head: null, refs: {} };
// --- end 2D T18 ---

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
