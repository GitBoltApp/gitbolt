import type { AvatarPayload } from './gen/AvatarPayload';
import type { BlobSource } from './gen/BlobSource';
import type { CommandLogEntry } from './gen/CommandLogEntry';
import type { CommitDetailsPayload } from './gen/CommitDetailsPayload';
import type { CommitMessage } from './gen/CommitMessage';
import type { DiffContentsPayload } from './gen/DiffContentsPayload';
import type { DiffSpec } from './gen/DiffSpec';
import type { FileListPayload } from './gen/FileListPayload';
import type { GraphPayload } from './gen/GraphPayload';
import type { RemotePayload } from './gen/RemotePayload';
import type { RepoSummary } from './gen/RepoSummary';
import type { SignaturePayload } from './gen/SignaturePayload';
import { createTransport, type Transport } from './transport';

let transport: Transport | undefined;
/** One `diffContents` request: the two sides the file list built, sent back unchanged. */
export interface ContentsRequest { path: string; old: BlobSource; new: BlobSource; force: boolean }

const t = () => (transport ??= createTransport(() => { transport = undefined; }));

export const api = {
  openRepo: (path: string) => t().call({ method: 'openRepo', params: { path } }) as Promise<RepoSummary>,
  graph: (repo: number, limit: number | null = null) => t().call({ method: 'graph', params: { repo, limit } }) as Promise<GraphPayload>,
  commandLog: () => t().call({ method: 'commandLog' }) as Promise<CommandLogEntry[]>,
  launchRepo: () => t().call({ method: 'launchRepo' }) as Promise<string | null>,
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
};

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
