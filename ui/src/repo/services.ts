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

/** The diff contents cache: 64 entries or 64 MiB (spec §4.4). */
export const CONTENT_CACHE_ENTRIES = 64;
export const CONTENT_CACHE_BYTES = 64 * 1024 * 1024;

/** One repository's backend reads, each cached per repo (one instance per open repo). */
export interface RepoServices {
  /** The details header (§9.1). Keyed by commit id. */
  details: Loader<CommitDetailsPayload>;
  /** Keyed by `filesKey(spec)`. */
  files: Loader<FileListPayload>;
  /** Keyed by `contentKey(request)`. */
  contents: Loader<DiffContentsPayload>;
  signature: Loader<SignaturePayload>;
  /** "View all files" (§9.3). Keyed by commit id. */
  treeFiles: Loader<string[]>;
  /**
   * Full commit messages (`commitMessage`), shared by the graph's full-message tooltip and the
   * details panel's message (§9.2), so either one warms the other.
   */
  messages: CommitMessageCache;
  /** Loaded once per repo (a failed load is retried on the next call). */
  remotes(): Promise<RemotePayload[]>;
}

export const filesKey = (spec: DiffSpec) => JSON.stringify(spec);
export const contentKey = (r: ContentsRequest) => JSON.stringify({ path: r.path, old: r.old, new: r.new, force: r.force });

/** WIP and worktree reads change under us (there's no watcher until 1C), so they're never
 * cached (plan 1B deviation 9). Object-id-addressed contents are immutable. */
export const isMutableKey = (key: string) => key.includes('"kind":"worktree"') || key.includes('"kind":"wip"');

/** Approximate bytes held: decoded text as UTF-16, plus base64 image bytes. */
export const contentSize = (c: DiffContentsPayload) =>
  [c.old, c.new].reduce((n, b) => n + (b ? (b.text?.length ?? 0) * 2 + (b.base64?.length ?? 0) : 0), 0);

export function createServices(repo: number): RepoServices {
  let remotes: Promise<RemotePayload[]> | undefined;
  return {
    details: new Loader((id) => api.commitDetails(repo, id), new Lru(256)),
    files: new Loader((k) => api.fileList(repo, JSON.parse(k) as DiffSpec), new Lru(128), 4, (k) => !isMutableKey(k)),
    contents: new Loader((k) => api.diffContents(repo, JSON.parse(k) as ContentsRequest), new Lru(CONTENT_CACHE_ENTRIES, CONTENT_CACHE_BYTES, contentSize), 4, (k) => !isMutableKey(k)),
    signature: new Loader((id) => api.signature(repo, id), new Lru(512), 2),
    treeFiles: new Loader((id) => api.treeFiles(repo, id), new Lru(4), 1),
    messages: createCommitMessageCache((id) => api.commitMessage(repo, id)),
    remotes: () => (remotes ??= api.remotes(repo).catch((e: unknown) => {
      remotes = undefined;
      throw e;
    })),
  };
}
