import type { AvatarPayload } from './gen/AvatarPayload';
import type { BlobSource } from './gen/BlobSource';
import type { CommandLogEntry } from './gen/CommandLogEntry';
import type { CommitDetailsPayload } from './gen/CommitDetailsPayload';
import type { CommitMessage } from './gen/CommitMessage';
import type { DiffContentsPayload } from './gen/DiffContentsPayload';
import type { DiffSpec } from './gen/DiffSpec';
import type { FileListPayload } from './gen/FileListPayload';
import type { GraphPayload } from './gen/GraphPayload';
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
import type { ScannedRepo } from './gen/ScannedRepo';
import type { SidebarPayload } from './gen/SidebarPayload';
import type { StatePayload } from './gen/StatePayload';
import { createTransport, deliver, type EventHandler, type Transport } from './transport';

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
  /** `extra` (plan 1C): the pinned trunk (spec §8.2), and `rescan` to re-read the WIP status. */
  graph: (repo: number, limit: number | null = null, extra: { pin?: PinSetting; rescan?: boolean } = {}) =>
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
  treeFiles: (repo: number, id: string) => t().call({ method: 'treeFiles', params: { repo, id } }) as Promise<string[]>,
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
};

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
