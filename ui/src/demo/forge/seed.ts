// The harness fake forge's seed types (fake_forge/mod.rs, gitlab_mrs.rs) as serde writes them into forge.json v1.
// The harness also writes fields the demo has no use for (tokens, created, feature switches); they're left out here.
export interface FakeUser { id: number; username: string; name: string; email: string | null; avatarUrl: string | null }
export interface FakeProject { id: number; path: string; defaultBranch: string | null; httpUrl: string | null; sshUrl: string | null; forkOf: string | null; updatedAt: string; archived: boolean; settings: Record<string, unknown> | null; singlePeople: boolean }
export interface FakeLabel { name: string; color: string; description: string | null }
export interface FakePosition { newPath: string; oldPath: string; newLine: number | null; oldLine: number | null; start: [number | null, number | null] | null; headSha: string }
export interface FakeAward { id: number; name: string; user: string }
export interface FakeNote { id: number; author: string; body: string; createdAt: string; system: boolean; position: FakePosition | null; awards: FakeAward[] }
export interface FakeDiscussion { id: string; notes: FakeNote[]; resolvable: boolean; resolved: boolean; resolvedBy: string | null; resolvedAt: string | null }
export interface FakeDiff { oldPath: string; newPath: string; diff: string }
export interface FakeDraftNote { id: number; author: string; note: string; position: Record<string, unknown> | null }
export interface FakeMergeRequest { iid: number; project: string; sourceProject: string; sourceBranch: string; targetBranch: string; title: string; description: string; state: string; author: string; headSha: string; pipeline: string | null; approvedBy: string[]; approvalsRequired: number; reviewers: string[]; assignees: string[]; labels: string[]; hasConflicts: boolean; mergeStatus: string; squash: boolean; removeSourceBranch: boolean | null; locksOnMerge: boolean; autoMergeBy: string | null; mergeCommitMessage: string | null; squashCommitMessage: string | null; mergeCommitSha: string; squashCommitSha: string; updatedAt: string; discussions: FakeDiscussion[]; diffs: FakeDiff[]; baseSha: string; subscribers: string[]; changesRequestedBy: string[]; draftNotes: FakeDraftNote[]; divergedCommitsCount: number; rebaseInProgress: boolean; rebaseError: string | null; rebaseForbidden: boolean; mergeError: string | null; rebases: number; rebaseSkippedCi: boolean }
export interface GitLabSeed { version: string; projects: FakeProject[]; avatars: Record<string, string>; mergeRequests: FakeMergeRequest[]; users: FakeUser[]; members: FakeUser[]; labels: FakeLabel[]; files: Record<string, Record<string, string>>; uploads: string[] }
export interface ForgeFile { version: 1; host: string; project: string; me: string; gitlab: GitLabSeed }

export const MR_DEFAULTS: Omit<FakeMergeRequest, 'iid' | 'project' | 'sourceBranch' | 'targetBranch' | 'title' | 'state' | 'author'> = {
  sourceProject: '', description: '', headSha: '', pipeline: null, approvedBy: [], approvalsRequired: 0, reviewers: [], assignees: [], labels: [], hasConflicts: false,
  mergeStatus: '', squash: false, removeSourceBranch: null, locksOnMerge: false, autoMergeBy: null, mergeCommitMessage: null, squashCommitMessage: null,
  mergeCommitSha: '', squashCommitSha: '', updatedAt: '', discussions: [], diffs: [], baseSha: '', subscribers: [], changesRequestedBy: [], draftNotes: [],
  divergedCommitsCount: 0, rebaseInProgress: false, rebaseError: null, rebaseForbidden: false, mergeError: null, rebases: 0, rebaseSkippedCi: false,
};

// What the harness may leave out of a hand-written file: any field, at any depth we fill in.
type Raw<T> = { [K in keyof T]?: T[K] extends (infer E)[] ? Raw<E>[] : T[K] };

/** A forge.json's text, every field the harness leaves out (`serde(default)`) filled in. */
export function parseForgeFile(text: string): ForgeFile {
  const raw = JSON.parse(text) as Omit<ForgeFile, 'gitlab'> & { gitlab: Raw<GitLabSeed> };
  if (raw.version !== 1) throw new Error(`forge.json version ${String(raw.version)}: the demo reads version 1`);
  const g = raw.gitlab;
  if (!g) throw new Error('forge.json has no gitlab seed');
  const user = (u: Raw<FakeUser>): FakeUser => ({ id: 0, username: '', name: '', email: null, avatarUrl: null, ...u });
  const position = (p: Raw<FakePosition>): FakePosition => ({ newPath: '', oldPath: '', newLine: null, oldLine: null, start: null, headSha: '', ...p });
  const note = (n: Raw<FakeNote>): FakeNote => ({
    id: 0, author: '', body: '', createdAt: '', system: false, ...n,
    position: n.position ? position(n.position) : null,
    awards: (n.awards ?? []).map((a) => ({ id: 0, name: '', user: '', ...a })),
  });
  const diff = (d: Raw<FakeDiff>): FakeDiff => ({ oldPath: '', newPath: '', diff: '', ...d });
  const draft = (d: Raw<FakeDraftNote>): FakeDraftNote => ({ id: 0, author: '', note: '', position: null, ...d });
  return {
    ...raw,
    gitlab: {
      version: g.version ?? '',
      projects: (g.projects ?? []).map((p) => ({ id: 0, path: '', defaultBranch: null, httpUrl: null, sshUrl: null, forkOf: null, updatedAt: '', archived: false, settings: null, singlePeople: false, ...p })),
      avatars: g.avatars ?? {},
      users: (g.users ?? []).map(user),
      members: (g.members ?? []).map(user),
      labels: (g.labels ?? []).map((l) => ({ name: '', color: '', description: null, ...l })),
      files: g.files ?? {},
      uploads: g.uploads ?? [],
      mergeRequests: (g.mergeRequests ?? []).map((m) => ({
        ...MR_DEFAULTS,
        ...m,
        discussions: (m.discussions ?? []).map((d) => ({ id: '', resolvable: false, resolved: false, resolvedBy: null, resolvedAt: null, ...d, notes: (d.notes ?? []).map(note) })),
        diffs: (m.diffs ?? []).map(diff),
        draftNotes: (m.draftNotes ?? []).map(draft),
      })) as FakeMergeRequest[],
    },
  };
}
