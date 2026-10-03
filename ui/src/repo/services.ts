import { api, type ContentsRequest } from '../api/client';
import { createCommitMessageCache, type CommitMessageCache } from '../api/commitMessages';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { RemotePayload } from '../api/gen/RemotePayload';
import type { SignaturePayload } from '../api/gen/SignaturePayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { hexSize, loadContents } from '../diff/hexContents';
import { WipLists } from './wipLists';

/** The diff contents cache: 64 entries or 64 MiB (spec §4.4). */
export const CONTENT_CACHE_ENTRIES = 64;
export const CONTENT_CACHE_BYTES = 64 * 1024 * 1024;

/** One repository's backend reads, each cached per repo (one instance per open repo). */
export interface RepoServices {
  /** The details header (§9.1). Keyed by commit id. */
  details: Loader<CommitDetailsPayload>;
  /** Keyed by `filesKey(spec)`. WIP lists are read through `wip`. */
  files: Loader<FileListPayload>;
  /** The WIP rows' lists (keyed by `filesKey(spec)` too), held while the tab is watched (K44). */
  wip: WipLists;
  /** Keyed by `contentKey(request)`. */
  contents: Loader<DiffContentsPayload>;
  signature: Loader<SignaturePayload>;
  /** "View all files" (§9.3). Keyed by commit id. */
  treeFiles: Loader<string[]>;
  /** UX G.2: the WIP row's View all files. Keyed by worktree; never cached (the index moves). */
  worktreeFiles: Loader<string[]>;
  /**
   * Full commit messages (`commitMessage`), shared by the graph's full-message tooltip and the
   * details panel's message (§9.2), so either one warms the other.
   */
  messages: CommitMessageCache;
  /** Loaded once per repo (a failed load is retried on the next call). */
  remotes(): Promise<RemotePayload[]>;
  /** `remotes()`'s result, once it has resolved (else `null`): synchronous, for a caller that
   * can't await it (a menu build, a message's first render). The one cache of "this repo's
   * remotes, loaded" — `useProjectRemote` (`details/Message.tsx`) and the file menu's env
   * (`menu/menuEnv.ts`) both read it instead of keeping their own. */
  remotesSnapshot(): RemotePayload[] | null;
}

export const filesKey = (spec: DiffSpec) => JSON.stringify(spec);
export const contentKey = (r: ContentsRequest) => JSON.stringify({ path: r.path, old: r.old, new: r.new, force: r.force });

/** WIP and worktree reads change under us, so the `Loader`s never cache them (plan 1B deviation
 * 9); WIP lists are held by `WipLists` instead, only while a watcher keeps them current (K44).
 * Object-id-addressed contents are immutable. */
export const isMutableKey = (key: string) => key.includes('"kind":"worktree"') || key.includes('"kind":"wip"');

/** Approximate bytes held: decoded text as UTF-16, plus base64 image bytes and a binary's hex dumps. */
export const contentSize = (c: DiffContentsPayload) =>
  [c.old, c.new].reduce((n, b) => n + (b ? (b.text?.length ?? 0) * 2 + (b.base64?.length ?? 0) : 0), 0) + hexSize(c);

export function createServices(repo: number): RepoServices {
  let remotes: Promise<RemotePayload[]> | undefined;
  let snapshot: RemotePayload[] | null = null;
  return {
    details: new Loader((id) => api.commitDetails(repo, id), new Lru(256)),
    files: new Loader((k) => api.fileList(repo, JSON.parse(k) as DiffSpec), new Lru(128), 4, (k) => !isMutableKey(k)),
    wip: new WipLists((spec) => api.fileList(repo, spec)),
    contents: new Loader((k) => loadContents(repo, JSON.parse(k) as ContentsRequest), new Lru(CONTENT_CACHE_ENTRIES, CONTENT_CACHE_BYTES, contentSize), 4, (k) => !isMutableKey(k)),
    signature: new Loader((id) => api.signature(repo, id), new Lru(512), 2),
    treeFiles: new Loader((id) => api.treeFiles(repo, id), new Lru(4), 1),
    worktreeFiles: new Loader((wt) => api.worktreeFiles(repo, wt), new Lru(1), 1, () => false),
    messages: createCommitMessageCache((id) => api.commitMessage(repo, id)),
    remotes: () => (remotes ??= api.remotes(repo).then((r) => (snapshot = r)).catch((e: unknown) => {
      remotes = undefined;
      throw e;
    })),
    remotesSnapshot: () => snapshot,
  };
}
