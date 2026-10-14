// The harness fake forge's GitLab (crates/gitvolt-harness/src/fake_forge/gitlab.rs, gitlab_mrs.rs,
// create.rs), answering without HTTP: the same seed, the same JSON, the same write semantics, so
// gitvolt-forge's mapping (gitlabJson.ts) makes of it what the core makes of the fake's answers.
import type { ReviewLine } from '../../api/gen/ReviewLine';
import { compareBytes } from '../engine/refs';
import { commentableLines, lineCode } from './review';
import { type FakeAward, type FakeDiscussion, type FakeDraftNote, type FakeMergeRequest, type FakeNote, type FakePosition, type FakeProject, type FakeUser, type ForgeFile, type GitLabSeed, MR_DEFAULTS } from './seed';

export const WEB = 'https://gitlab.example.com';
export type Json = Record<string, unknown>;

export class FakeHttp extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
export const notFound = () => new FakeHttp(404, { message: '404 Not found' });
const forbidden = () => new FakeHttp(403, { message: '403 Forbidden' });
const badRequest = () => new FakeHttp(400, { message: '400 Bad request' });

const DRAFT = ['draft:', '[draft]', '(draft)', 'draft -', 'wip:', '[wip]'];
export const isDraft = (title: string) => DRAFT.some((p) => title.trimStart().toLowerCase().startsWith(p));
const shaOrNull = (s: string) => (s === '' ? null : s);
/** A pipeline that hasn't finished (one an auto-merge waits for). */
export const isUnfinished = (pipeline: string | null) => ['created', 'pending', 'running', 'waiting_for_resource', 'preparing'].includes(pipeline ?? '');

export interface MrQuery { state?: string; sourceBranch?: string; targetBranch?: string; scope?: 'created_by_me' | 'assigned_to_me'; reviewerId?: number; updatedAfter?: string }

export class FakeGitLab {
  seed: GitLabSeed = { version: '18.9.1-ee', projects: [], avatars: {}, mergeRequests: [], users: [], members: [], labels: [], files: {}, uploads: [] };
  me = 'you';
  now: () => string;

  constructor(files: ForgeFile[], now: () => string) {
    this.now = now;
    for (const f of files) this.add(f);
  }

  add(file: ForgeFile): void {
    // A copy: the fake's writes (a GET that ends a rebase) never reach the caller's parsed file.
    const f = structuredClone(file);
    const g = f.gitlab;
    this.me = f.me;
    if (g.version) this.seed.version = g.version;
    const byId = <T extends { id: number }>(have: T[], more: T[]) => [...have, ...more.filter((x) => !have.some((y) => y.id === x.id))];
    this.seed.projects = [...this.seed.projects, ...g.projects.filter((p) => !this.seed.projects.some((q) => q.path === p.path))];
    this.seed.users = byId(this.seed.users, g.users);
    this.seed.members = byId(this.seed.members, g.members);
    this.seed.labels = [...this.seed.labels, ...g.labels.filter((l) => !this.seed.labels.some((x) => x.name === l.name))];
    this.seed.mergeRequests.push(...g.mergeRequests.filter((m) => !this.seed.mergeRequests.some((x) => x.project === m.project && x.iid === m.iid)));
    for (const [project, files] of Object.entries(g.files)) this.seed.files[project] = { ...this.seed.files[project], ...files };
    Object.assign(this.seed.avatars, g.avatars);
    this.seed.uploads.push(...g.uploads.filter((u) => !this.seed.uploads.includes(u)));
  }

  /** gitlab_mrs.rs `person`: a member or user by username, else a stand-in. */
  person(username: string): FakeUser {
    return [...this.seed.members, ...this.seed.users].find((u) => u.username === username) ?? { id: 999, username, name: username, email: null, avatarUrl: null };
  }

  /** gitlab.rs `user_json`. */
  userJson(u: FakeUser): Json {
    return { id: u.id, username: u.username, name: u.name, avatar_url: u.avatarUrl, web_url: `${WEB}/${u.username}`, public_email: u.email, email: u.email };
  }

  project(idOrPath: string | number): FakeProject {
    const p = this.seed.projects.find((x) => x.path === String(idOrPath) || String(x.id) === String(idOrPath));
    if (!p) throw new FakeHttp(404, { message: '404 Project Not Found' });
    return p;
  }

  /** gitlab.rs `project_json`. */
  projectJson(p: FakeProject): Json {
    const i = p.path.lastIndexOf('/');
    const [owner, name] = i < 0 ? ['', p.path] : [p.path.slice(0, i), p.path.slice(i + 1)];
    const v: Json = {
      id: p.id, name, path: name, path_with_namespace: p.path, namespace: { full_path: owner }, web_url: `${WEB}/${p.path}`, default_branch: p.defaultBranch,
      http_url_to_repo: p.httpUrl ?? `${WEB}/${p.path}.git`, ssh_url_to_repo: p.sshUrl ?? `git@gitlab.example.com:${p.path}.git`, last_activity_at: p.updatedAt, archived: p.archived,
      squash_option: 'default_off', merge_method: 'merge', remove_source_branch_after_merge: true,
    };
    const parent = p.forkOf ? this.seed.projects.find((x) => x.path === p.forkOf) : undefined;
    if (parent) v.forked_from_project = { id: parent.id, path_with_namespace: parent.path };
    return { ...v, ...(p.settings ?? {}) };
  }

  projectId(path: string): number {
    return this.seed.projects.find((p) => p.path === path)?.id ?? 0;
  }

  mr(project: string, iid: number): FakeMergeRequest {
    const m = this.seed.mergeRequests.find((x) => x.project === project && x.iid === iid);
    if (!m) throw notFound();
    return m;
  }

  private pipelineJson(m: FakeMergeRequest, status: string): Json {
    const id = 50_000 + m.iid;
    return { id, sha: m.headSha, ref: m.sourceBranch, status, web_url: `${WEB}/${m.project}/-/pipelines/${id}`, updated_at: m.updatedAt };
  }

  /** gitlab_mrs.rs `mr_json`. */
  mrJson(m: FakeMergeRequest, single: boolean): Json {
    const source = m.sourceProject || m.project;
    const users = (names: string[]) => names.map((u) => this.userJson(this.person(u)));
    const v: Json = {
      id: 10_000 + m.iid, iid: m.iid, project_id: this.projectId(m.project), title: m.title, description: m.description, state: m.state,
      draft: isDraft(m.title), work_in_progress: isDraft(m.title), source_branch: m.sourceBranch, target_branch: m.targetBranch,
      source_project_id: this.projectId(source), target_project_id: this.projectId(m.project), author: this.userJson(this.person(m.author)),
      reviewers: users(m.reviewers), assignees: users(m.assignees), labels: m.labels, sha: m.headSha, web_url: `${WEB}/${m.project}/-/merge_requests/${m.iid}`,
      has_conflicts: m.hasConflicts, detailed_merge_status: m.mergeStatus || 'mergeable', squash: m.squash, force_remove_source_branch: m.removeSourceBranch,
      updated_at: m.updatedAt, merge_when_pipeline_succeeds: m.autoMergeBy !== null, merge_user: m.autoMergeBy === null ? null : this.userJson(this.person(m.autoMergeBy)),
      merge_commit_sha: shaOrNull(m.mergeCommitSha), squash_commit_sha: shaOrNull(m.squashCommitSha),
    };
    if (single) {
      v.head_pipeline = m.pipeline === null ? null : this.pipelineJson(m, m.pipeline);
      if (m.baseSha) v.diff_refs = { base_sha: m.baseSha, start_sha: m.baseSha, head_sha: m.headSha };
    }
    return v;
  }

  /** `mr_json_for`: a single MR's JSON for the token's user (`subscribed` is theirs). */
  mrJsonFor(m: FakeMergeRequest): Json {
    return { ...this.mrJson(m, true), subscribed: m.subscribers.includes(this.me) };
  }

  /** The route `GET merge_requests/:iid`. */
  getMr(project: string, iid: number, ask: { diverged: boolean; rebaseInProgress: boolean }): Json {
    const m = this.mr(project, iid);
    const v: Json = { ...this.mrJsonFor(m), merge_error: m.mergeError };
    if (ask.diverged) v.diverged_commits_count = m.divergedCommitsCount;
    if (ask.rebaseInProgress) {
      v.rebase_in_progress = m.rebaseInProgress;
      m.rebaseInProgress = false;
    }
    if (m.state === 'locked') {
      m.state = 'merged';
      m.updatedAt = this.now();
    }
    return v;
  }

  /** `query_matches` and the list's order. */
  listMrs(project: string, q: MrQuery): Json[] {
    return this.seed.mergeRequests
      .filter((m) => m.project === project)
      .filter((m) => !q.state || q.state === 'all' || m.state === q.state)
      .filter((m) => q.sourceBranch === undefined || m.sourceBranch === q.sourceBranch)
      .filter((m) => q.targetBranch === undefined || m.targetBranch === q.targetBranch)
      .filter((m) => q.updatedAfter === undefined || m.updatedAt >= q.updatedAfter)
      .filter((m) => (q.scope === 'created_by_me' ? m.author === this.me : q.scope === 'assigned_to_me' ? m.assignees.includes(this.me) : true))
      .filter((m) => q.reviewerId === undefined || m.reviewers.some((u) => this.person(u).id === q.reviewerId))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((m) => ({ ...this.mrJson(m, false), labels: m.labels.map((l) => ({ name: l, color: this.seed.labels.find((x) => x.name === l)?.color ?? null })) }));
  }

  /** `/projects/:id/pipelines`: each MR head's pipeline, newest first. */
  pipelinesJson(project: string): Json[] {
    return this.seed.mergeRequests.filter((m) => m.project === project && m.pipeline !== null).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((m) => this.pipelineJson(m, m.pipeline!));
  }

  /** `approvals_json`. */
  approvalsJson(m: FakeMergeRequest): Json {
    const left = Math.max(0, m.approvalsRequired - m.approvedBy.length);
    return { approved: left === 0 && m.approvedBy.length > 0, approvals_required: m.approvalsRequired, approvals_left: left, approved_by: m.approvedBy.map((u) => ({ user: this.userJson(this.person(u)) })) };
  }

  /** `note_json`. */
  noteJson(n: FakeNote, resolvable: boolean, resolved: boolean): Json {
    const at = ([nw, old]: [number | null, number | null]) => ({ line_code: `f00d_${old ?? 0}_${nw ?? 0}`, type: nw !== null && old === null ? 'new' : nw === null && old !== null ? 'old' : null, new_line: nw, old_line: old });
    const p = n.position;
    return {
      id: n.id, body: n.body, author: this.userJson(this.person(n.author)), created_at: n.createdAt, system: n.system, type: p ? 'DiffNote' : null,
      position: p === null ? null : {
        position_type: 'text', new_path: p.newPath, old_path: p.oldPath, new_line: p.newLine, old_line: p.oldLine,
        line_range: p.start === null ? null : { start: at(p.start), end: at([p.newLine, p.oldLine]) }, head_sha: p.headSha === '' ? null : p.headSha,
      },
      resolvable, resolved,
    };
  }

  /** `discussion_json`. */
  discussionJson(d: FakeDiscussion): Json {
    const by = d.resolved && d.resolvedBy ? this.userJson(this.person(d.resolvedBy)) : null;
    const at = d.resolved && d.resolvedAt ? d.resolvedAt : null;
    const notes = d.notes.map((n) => ({ ...this.noteJson(n, d.resolvable, d.resolved), ...(d.resolvable ? { resolved_by: by, resolved_at: at } : {}) }));
    return { id: d.id, individual_note: d.notes.length === 1 && !d.resolvable, notes };
  }

  /** `/diffs`. */
  diffsJson(m: FakeMergeRequest): Json[] {
    return m.diffs.map((d) => ({ old_path: d.oldPath, new_path: d.newPath, diff: d.diff, new_file: false, deleted_file: false, renamed_file: d.oldPath !== d.newPath }));
  }

  /** `draft_json`. */
  draftJson(iid: number, d: FakeDraftNote): Json {
    return { id: d.id, author_id: this.person(d.author).id, merge_request_id: 10_000 + iid, resolve_discussion: false, discussion_id: null, note: d.note, commit_id: null, line_code: null, position: d.position };
  }

  /** `/projects/:id/labels?search=` (create.rs `gitlab_labels`): the seed's labels whose name holds `search`, any case. */
  labelsJson(idOrPath: string | number, search = ''): Json[] {
    this.project(idOrPath);
    const q = search.toLowerCase();
    return this.seed.labels.map((l, i) => ({ id: i + 1, name: l.name, color: l.color, description: l.description })).filter((l) => l.name.toLowerCase().includes(q));
  }

  /** GraphQL's every note's award emoji (gitlab_mrs.rs `graphql`, `awardEmoji`): one page. */
  noteAwardsJson(project: string, iid: number): Json {
    const m = this.seed.mergeRequests.find((x) => x.project === project && x.iid === iid);
    if (!m) return { data: { project: { mergeRequest: null } } };
    const nodes = m.discussions.flatMap((d) => d.notes).map((n) => ({
      id: `gid://gitlab/Note/${n.id}`,
      awardEmoji: { nodes: n.awards.map((a) => { const u = this.person(a.user); return { name: a.name, user: { id: `gid://gitlab/User/${u.id}`, username: u.username, name: u.name } }; }) },
    }));
    return { data: { project: { mergeRequest: { notes: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } };
  }

  /** GraphQL's people flags for `project` (any one MR's). */
  peopleFlags(project: string): Json {
    const p = this.seed.projects.find((x) => x.path === project);
    if (!p) return { data: { project: null } };
    const nodes = this.seed.mergeRequests.filter((m) => m.project === project).slice(0, 1).map(() => ({ allowsMultipleReviewers: !p.singlePeople, allowsMultipleAssignees: !p.singlePeople }));
    return { data: { project: { mergeRequests: { nodes } } } };
  }

  // --- writes (gitlab_mrs.rs): each throws FakeHttp as the harness answers ---

  /** `new_note`'s id: one past the highest note's, from 1001. */
  private nextNoteId(): number {
    return Math.max(1000, ...this.seed.mergeRequests.flatMap((m) => m.discussions.flatMap((d) => d.notes.map((n) => n.id)))) + 1;
  }

  /** POST `…/notes` (a new discussion) and `…/discussions/:did/notes` (a reply); both 201. */
  addNote(project: string, iid: number, discussion: string | null, body: string): Json {
    const m = this.mr(project, iid);
    const note: FakeNote = { id: this.nextNoteId(), author: this.me, body, createdAt: this.now(), system: false, position: null, awards: [] };
    if (discussion === null) {
      m.discussions.push({ id: `d${note.id}`, notes: [note], resolvable: false, resolved: false, resolvedBy: null, resolvedAt: null });
      return this.noteJson(note, false, false);
    }
    const d = m.discussions.find((x) => x.id === discussion);
    if (!d) throw notFound();
    d.notes.push(note);
    return this.noteJson(note, d.resolvable, d.resolved);
  }

  /** `note_at`: a note of any discussion, by id. */
  private noteAt(project: string, iid: number, noteId: string): { d: FakeDiscussion; n: FakeNote; m: FakeMergeRequest } {
    const m = this.mr(project, iid);
    for (const d of m.discussions) for (const n of d.notes) if (String(n.id) === noteId) return { d, n, m };
    throw notFound();
  }

  /** `award_json`. */
  private awardJson(a: FakeAward): Json {
    return { id: a.id, name: a.name, user: this.userJson(this.person(a.user)), awardable_type: 'Note' };
  }

  /** GET `…/notes/:id/award_emoji`. */
  noteAwards(project: string, iid: number, noteId: string): Json[] {
    return this.noteAt(project, iid, noteId).n.awards.map((a) => this.awardJson(a));
  }

  /** POST `…/award_emoji` (201): anyone may award, once per name. */
  award(project: string, iid: number, noteId: string, name: string): Json {
    const { n } = this.noteAt(project, iid, noteId);
    if (n.awards.some((a) => a.name === name && a.user === this.me)) throw new FakeHttp(404, { message: { base: ['Award Emoji Name has already been taken'] } });
    const id = Math.max(500, ...this.seed.mergeRequests.flatMap((m) => m.discussions.flatMap((d) => d.notes.flatMap((x) => x.awards.map((a) => a.id))))) + 1;
    const a: FakeAward = { id, name, user: this.me };
    n.awards.push(a);
    return this.awardJson(a);
  }

  /** DELETE `…/award_emoji/:id`: only an award's user removes it. */
  unaward(project: string, iid: number, noteId: string, awardId: number): void {
    const { n } = this.noteAt(project, iid, noteId);
    const k = n.awards.findIndex((a) => a.id === awardId);
    if (k < 0) throw notFound();
    if (n.awards[k].user !== this.me) throw forbidden();
    n.awards.splice(k, 1);
  }

  /** PUT `…/notes/:id`: only the note's author edits it. */
  editNote(project: string, iid: number, noteId: string, body: string): Json {
    const { d, n } = this.noteAt(project, iid, noteId);
    if (n.author !== this.me) throw forbidden();
    n.body = body;
    return this.noteJson(n, d.resolvable, d.resolved);
  }

  /** DELETE `…/notes/:id`: only the note's author; a discussion left empty goes. */
  deleteNote(project: string, iid: number, noteId: string): void {
    const { d, n, m } = this.noteAt(project, iid, noteId);
    if (n.author !== this.me) throw forbidden();
    d.notes.splice(d.notes.indexOf(n), 1);
    if (d.notes.length === 0) m.discussions.splice(m.discussions.indexOf(d), 1);
  }

  /** PUT `…/discussions/:did?resolved=`: 400 when it isn't resolvable. */
  resolve(project: string, iid: number, discussion: string, on: boolean): Json {
    const d = this.mr(project, iid).discussions.find((x) => x.id === discussion);
    if (!d) throw notFound();
    if (!d.resolvable) throw badRequest();
    d.resolved = on;
    d.resolvedBy = on ? this.me : null;
    d.resolvedAt = on ? this.now() : null;
    return this.discussionJson(d);
  }

  /** POST `…/approve` (201). */
  approve(project: string, iid: number): Json {
    const m = this.mr(project, iid);
    if (!m.approvedBy.includes(this.me)) m.approvedBy.push(this.me);
    if (m.mergeStatus === 'not_approved' && m.approvedBy.length >= m.approvalsRequired) m.mergeStatus = 'mergeable';
    return this.approvalsJson(m);
  }

  /** POST `…/unapprove` (201): 404 when the user hasn't approved. */
  unapprove(project: string, iid: number): Json {
    const m = this.mr(project, iid);
    if (!m.approvedBy.includes(this.me)) throw notFound();
    m.approvedBy = m.approvedBy.filter((u) => u !== this.me);
    if (m.mergeStatus === 'mergeable' && m.approvedBy.length < m.approvalsRequired) m.mergeStatus = 'not_approved';
    return this.approvalsJson(m);
  }

  /** GraphQL's `mergeRequestRequestChanges`: the answer's JSON (an MR that isn't there, errors). */
  requestChanges(project: string, iid: number): Json {
    const m = this.seed.mergeRequests.find((x) => x.project === project && x.iid === iid);
    if (!m) return { data: { mergeRequestRequestChanges: null }, errors: [{ message: 'The resource that you are attempting to access does not exist' }] };
    if (!m.changesRequestedBy.includes(this.me)) m.changesRequestedBy.push(this.me);
    return { data: { mergeRequestRequestChanges: { errors: [] } } };
  }

  /** POST `…/subscribe` and `…/unsubscribe` (201); null is GitLab's 304: already so. */
  subscribe(project: string, iid: number, on: boolean): Json | null {
    const m = this.mr(project, iid);
    if (m.subscribers.includes(this.me) === on) return null;
    m.subscribers = on ? [...m.subscribers, this.me] : m.subscribers.filter((u) => u !== this.me);
    return this.mrJsonFor(m);
  }

  // --- merging, auto-merge, GitLab's rebase and edits (gitlab_mrs.rs) ---

  /** PUT `…/merge`: 405 when it isn't open or can't merge now (an auto-merge waits for an unfinished pipeline instead), 409 when `sha` isn't the head. */
  merge(project: string, iid: number, b: Json): Json {
    const m = this.mr(project, iid);
    const mergeable = m.mergeStatus === '' || m.mergeStatus === 'mergeable';
    // Either flag: 17.11's `auto_merge`, the older one.
    const auto = b.auto_merge === true || b.merge_when_pipeline_succeeds === true;
    const waits = auto && isUnfinished(m.pipeline) && m.state === 'opened' && !isDraft(m.title) && !m.hasConflicts;
    if (m.state !== 'opened' || (!mergeable && !waits)) throw new FakeHttp(405, { message: '405 Method Not Allowed' });
    if (typeof b.sha === 'string' && b.sha !== m.headSha) throw new FakeHttp(409, { message: `SHA does not match HEAD of source branch: ${m.headSha}` });
    if (waits) m.autoMergeBy = this.me;
    else m.state = m.locksOnMerge ? 'locked' : 'merged';
    if (typeof b.squash === 'boolean') m.squash = b.squash;
    if (typeof b.should_remove_source_branch === 'boolean') m.removeSourceBranch = b.should_remove_source_branch;
    m.mergeCommitMessage = typeof b.merge_commit_message === 'string' ? b.merge_commit_message : null;
    m.squashCommitMessage = typeof b.squash_commit_message === 'string' ? b.squash_commit_message : null;
    m.updatedAt = this.now();
    return this.mrJson(m, true);
  }

  /** POST `…/cancel_merge_when_pipeline_succeeds`: 406 when it isn't set (or isn't open). */
  cancelAutoMerge(project: string, iid: number): Json {
    const m = this.mr(project, iid);
    if (m.state !== 'opened' || m.autoMergeBy === null) throw new FakeHttp(406, { message: '406 Not Acceptable' });
    m.autoMergeBy = null;
    m.updatedAt = this.now();
    return this.mrJson(m, true);
  }

  /** PUT `…/rebase` (202): queued, so the MR says it's in progress for one read; a seeded
   * `rebaseError` fails it, else the head becomes a made-up commit. 403 when it can't push. */
  rebase(project: string, iid: number, skipCi: boolean): void {
    const m = this.mr(project, iid);
    if (m.rebaseForbidden || m.state !== 'opened') throw new FakeHttp(403, { message: '403 Forbidden - Cannot push to source branch' });
    m.rebaseInProgress = true;
    m.mergeError = m.rebaseError;
    if (m.mergeError === null) {
      m.rebases++;
      m.headSha = (0xb0000 + m.iid * 0x100 + m.rebases).toString(16).padStart(40, '0');
      m.divergedCommitsCount = 0;
      if (m.mergeStatus === 'need_rebase') m.mergeStatus = 'mergeable';
      // A new head: its pipeline, unless skipped.
      m.pipeline = skipCi ? null : 'pending';
      m.rebaseSkippedCi = skipCi;
      m.updatedAt = this.now();
    }
  }

  /** The users a PUT can name, by id (the fake's tokens' users are the seed's `me`, a member). */
  private userById(id: number): FakeUser | undefined {
    return [...this.seed.users, ...this.seed.members].find((u) => u.id === id);
  }

  /** PUT `…/merge_requests/:iid`: the people as whole lists of ids (one it can't add is dropped
   * silently; a single-people project keeps the first), title, description, labels, target branch. */
  put(project: string, iid: number, b: Json): Json {
    const m = this.mr(project, iid);
    const single = this.seed.projects.find((p) => p.path === project)?.singlePeople ?? false;
    const people = (key: string): string[] | null => {
      const v = b[key];
      if (!Array.isArray(v)) return null;
      const names = v.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0).flatMap((id) => this.userById(id)?.username ?? []);
      return single ? names.slice(0, 1) : names;
    };
    const reviewers = people('reviewer_ids');
    const assignees = people('assignee_ids');
    if (reviewers) m.reviewers = reviewers;
    if (assignees) m.assignees = assignees;
    if (typeof b.title === 'string') m.title = b.title;
    if (typeof b.description === 'string') m.description = b.description;
    if (typeof b.labels === 'string') m.labels = b.labels.split(',').map((x) => x.trim()).filter(Boolean);
    if (typeof b.target_branch === 'string') m.targetBranch = b.target_branch;
    m.updatedAt = this.now();
    return this.mrJson(m, true);
  }

  /** The later of now and one second past the project's newest MR, so a new MR lists first even under a fixed clock. */
  private newest(project: string): string {
    const now = this.now();
    const latest = this.seed.mergeRequests.filter((m) => m.project === project && m.updatedAt !== '').map((m) => m.updatedAt).sort(compareBytes).pop();
    if (latest === undefined || latest < now) return now;
    return new Date(Date.parse(latest) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** GET `/projects/:id/members/all/:uid`: whoever a PUT can add. */
  member(idOrPath: string | number, uid: number): Json {
    this.project(idOrPath);
    const u = this.userById(uid);
    if (!u) throw notFound();
    return this.userJson(u);
  }
  // --- end merging ---

  // --- review comments: draft notes (the token user's own) and positioned threads ---

  /** gitlab_mrs.rs `check_position`: a position GitLab takes on `m` (text, its three SHAs, its last line one of the file's diff lines, a `line_range` whose ends are lines with their line codes); a 400 otherwise. */
  async checkPosition(m: FakeMergeRequest, p: Json): Promise<FakePosition> {
    const refused = () => new FakeHttp(400, { message: `400 Bad request - Note {:line_code=>["can't be blank", "must be a valid line code"]}` });
    const s = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
    if (s('position_type') !== 'text' || ['base_sha', 'start_sha', 'head_sha'].some((k) => s(k) === '')) throw refused();
    // The SHAs must be the MR's own diff refs, when it has them.
    if (m.baseSha !== '' && (s('base_sha') !== m.baseSha || s('start_sha') !== m.baseSha || s('head_sha') !== m.headSha)) throw refused();
    const newPath = s('new_path');
    const d = m.diffs.find((x) => x.newPath === newPath);
    if (!d) throw refused();
    const lines = commentableLines(d.diff);
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
    const at = (v: Json): [number | null, number | null] => [num(v.old_line), num(v.new_line)];
    const lineOf = (v: Json): ReviewLine | undefined => {
      const [o, n] = at(v);
      return lines.find((l) => (l.kind === 'added' ? null : l.oldLine) === o && (l.kind === 'removed' ? null : l.newLine) === n);
    };
    const end = lineOf(p) ?? (() => { throw refused(); })();
    let start: [number | null, number | null] | null = null;
    const range = p.line_range;
    if (range !== null && range !== undefined) {
      const r = range as { start: Json; end: Json };
      const first = lineOf(r.start ?? {});
      const last = lineOf(r.end ?? {});
      if (!first || !last) throw refused();
      const coded = async (v: Json, l: ReviewLine) => v.line_code === (await lineCode(newPath, l));
      if (last !== end || !(await coded(r.start, first)) || !(await coded(r.end, last))) throw refused();
      start = [num(r.start.new_line), num(r.start.old_line)];
    }
    return { newPath, oldPath: s('old_path'), newLine: num(p.new_line), oldLine: num(p.old_line), start, headSha: s('head_sha') };
  }

  /** GET `…/draft_notes`: the token user's, in order. */
  drafts(project: string, iid: number): Json[] {
    const m = this.mr(project, iid);
    return m.draftNotes.filter((d) => d.author === this.me).map((d) => this.draftJson(m.iid, d));
  }

  /** POST `…/draft_notes` (201): a position, when given, is checked; ids run on from 2000. (`drafts_drop_position` isn't modelled.) */
  async addDraft(project: string, iid: number, note: string, position: Json | null): Promise<Json> {
    const m = this.mr(project, iid);
    if (position !== null) await this.checkPosition(m, position);
    const id = Math.max(2000, ...this.seed.mergeRequests.flatMap((x) => x.draftNotes.map((d) => d.id))) + 1;
    const d: FakeDraftNote = { id, author: this.me, note, position };
    m.draftNotes.push(d);
    return this.draftJson(m.iid, d);
  }

  /** PUT `…/draft_notes/:id`: the token user's own draft's text. */
  editDraft(project: string, iid: number, id: string, note: string): Json {
    const m = this.mr(project, iid);
    const d = m.draftNotes.find((x) => String(x.id) === id && x.author === this.me);
    if (!d) throw notFound();
    d.note = note;
    return this.draftJson(m.iid, d);
  }

  /** DELETE `…/draft_notes/:id`. */
  deleteDraft(project: string, iid: number, id: string): void {
    const m = this.mr(project, iid);
    const k = m.draftNotes.findIndex((x) => String(x.id) === id && x.author === this.me);
    if (k < 0) throw notFound();
    m.draftNotes.splice(k, 1);
  }

  /** POST `…/draft_notes/bulk_publish` (204): each of the user's drafts becomes a resolvable discussion, in order; a position GitLab wouldn't take now leaves the note on no line. */
  async publishDrafts(project: string, iid: number): Promise<void> {
    const m = this.mr(project, iid);
    let id = this.nextNoteId();
    const mine = m.draftNotes.filter((d) => d.author === this.me);
    const placed: [string, FakePosition | null][] = [];
    for (const d of mine) placed.push([d.note, d.position === null ? null : await this.checkPosition(m, d.position).catch(() => null)]);
    m.draftNotes = m.draftNotes.filter((d) => d.author !== this.me);
    for (const [body, position] of placed) {
      const note: FakeNote = { id, author: this.me, body, createdAt: this.now(), system: false, position, awards: [] };
      m.discussions.push({ id: `d${id}`, notes: [note], resolvable: true, resolved: false, resolvedBy: null, resolvedAt: null });
      id += 1;
    }
    m.updatedAt = this.now();
  }

  /** POST `…/discussions` with a `position` (201): a diff thread, resolvable. */
  async addDiffThread(project: string, iid: number, body: string, position: Json): Promise<Json> {
    const m = this.mr(project, iid);
    const p = await this.checkPosition(m, position);
    const id = this.nextNoteId();
    const note: FakeNote = { id, author: this.me, body, createdAt: this.now(), system: false, position: p, awards: [] };
    const d: FakeDiscussion = { id: `d${id}`, notes: [note], resolvable: true, resolved: false, resolvedBy: null, resolvedAt: null };
    m.discussions.push(d);
    return this.discussionJson(d);
  }
  // --- end review comments ---

  // --- creating (fake_forge/create.rs) ---

  /** POST `/projects/:id/merge_requests` (201): the new MR, in the project the body's `target_project_id`
   * names (else `sourceProject`). 409 when the source project's branch has an open MR. The `iid` is one
   * past the target's highest (the harness counts only what it created, which collides with a seeded
   * MR's; the two agree on a project that has none). `sha`: the source branch's tip on the origin, when
   * the caller found it; else the harness's made-up one. */
  createMr(sourceProject: string, b: Json, sha: string | null = null): Json {
    const source = this.project(sourceProject);
    const targetId = b.target_project_id;
    const target = typeof targetId === 'number' ? (this.seed.projects.find((p) => p.id === targetId) ?? this.project(String(targetId))) : source;
    const [sourceBranch, targetBranch, title] = [b.source_branch, b.target_branch, b.title];
    if (typeof sourceBranch !== 'string' || typeof targetBranch !== 'string' || typeof title !== 'string') throw new FakeHttp(400, { message: 'source_branch, target_branch and title are required' });
    const dup = this.seed.mergeRequests.find((m) => (m.sourceProject || m.project) === source.path && m.sourceBranch === sourceBranch && m.state === 'opened');
    if (dup) throw new FakeHttp(409, { message: [`Another open merge request already exists for this source branch: !${dup.iid}`] });
    const iid = Math.max(0, ...this.seed.mergeRequests.filter((m) => m.project === target.path).map((m) => m.iid)) + 1;
    const pick = (key: string): string[] => {
      const v = b[key];
      const ids = Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
      return this.seed.members.filter((m) => ids.includes(m.id)).map((m) => m.username);
    };
    // GitLab takes `labels` as an array or one comma-separated string.
    const raw = Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === 'string') : typeof b.labels === 'string' ? b.labels.split(',') : [];
    const mr: FakeMergeRequest = {
      ...MR_DEFAULTS, iid, project: target.path, sourceProject: source.id === target.id ? '' : source.path, sourceBranch, targetBranch, title,
      description: typeof b.description === 'string' ? b.description : '', state: 'opened', author: this.me, headSha: sha ?? '1'.repeat(40),
      reviewers: pick('reviewer_ids'), assignees: pick('assignee_ids'), labels: raw.map((l) => l.trim()).filter(Boolean),
      squash: b.squash === true, removeSourceBranch: typeof b.remove_source_branch === 'boolean' ? b.remove_source_branch : null, updatedAt: this.newest(target.path),
    };
    this.seed.mergeRequests.push(mr);
    return this.mrJson(mr, false);
  }

  /** GET `/projects/:id/members/all?query=`: the seed's members whose username or name holds `query` (trimmed, any case), `perPage` of them. */
  members(idOrPath: string | number, query: string, perPage: number): Json[] {
    this.project(idOrPath);
    const q = query.trim().toLowerCase();
    return this.seed.members.filter((u) => q === '' || u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)).slice(0, perPage).map((u) => this.userJson(u));
  }

  /** GET `/projects/:id/repository/tree?path=`: the direct children of `dir` among the project's files (a branch isn't told apart); 404 when there are none. */
  tree(idOrPath: string | number, dir: string): Json[] {
    const p = this.project(idOrPath);
    const prefix = dir === '' ? '' : `${dir}/`;
    const out: { dir: boolean; path: string }[] = [];
    for (const path of Object.keys(this.seed.files[p.path] ?? {})) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      const entry = slash < 0 ? { dir: false, path } : { dir: true, path: `${prefix}${rest.slice(0, slash)}` };
      if (!out.some((x) => x.dir === entry.dir && x.path === entry.path)) out.push(entry);
    }
    if (out.length === 0) throw new FakeHttp(404, { message: '404 Tree Not Found' });
    return out.map((e) => ({ id: '0', name: e.path.slice(e.path.lastIndexOf('/') + 1), type: e.dir ? 'tree' : 'blob', path: e.path, mode: '100644' }));
  }

  /** GET `/projects/:id/repository/files/:path/raw`. */
  raw(idOrPath: string | number, file: string): string {
    const p = this.project(idOrPath);
    const content = this.seed.files[p.path]?.[file];
    if (content === undefined) throw new FakeHttp(404, { message: '404 File Not Found' });
    return content;
  }
  // --- end creating ---
}
