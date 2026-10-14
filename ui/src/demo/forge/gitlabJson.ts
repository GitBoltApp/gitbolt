// The forge crate's GitLab mapping (`crates/gitvolt-forge/src/gitlab.rs` `pub mod json`, GitLab's
// JSON to the normalized types), ported function for function for the demo: the fake GitLab
// (fakeGitlab.ts) answers as the harness's does, and this makes of it what the core makes of those
// answers. Each function names its Rust one; keep them twins. Fields the Rust leaves `None` (and
// serde skips) are left out of the object, as the generated types' optional fields say.
import type { AutoMerge } from '../../api/gen/AutoMerge';
import type { BranchUpdateOffer } from '../../api/gen/BranchUpdateOffer';
import type { CreateMr } from '../../api/gen/CreateMr';
import type { DiffPosition } from '../../api/gen/DiffPosition';
import type { DiffRefs } from '../../api/gen/DiffRefs';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeLabel } from '../../api/gen/ForgeLabel';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { ForgeNote } from '../../api/gen/ForgeNote';
import type { ForgePipeline } from '../../api/gen/ForgePipeline';
import type { ForgeProject } from '../../api/gen/ForgeProject';
import type { ForgeProjectSettings } from '../../api/gen/ForgeProjectSettings';
import type { ForgeReaction } from '../../api/gen/ForgeReaction';
import type { ForgeReview } from '../../api/gen/ForgeReview';
import type { ForgeUser } from '../../api/gen/ForgeUser';
import type { MergeMethod } from '../../api/gen/MergeMethod';
import type { MergeStatus } from '../../api/gen/MergeStatus';
import type { MrEdit } from '../../api/gen/MrEdit';
import type { MrState } from '../../api/gen/MrState';
import type { NewReviewComment } from '../../api/gen/NewReviewComment';
import type { PeopleLimits } from '../../api/gen/PeopleLimits';
import type { PipelineStatus } from '../../api/gen/PipelineStatus';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';
import type { ReviewFile } from '../../api/gen/ReviewFile';
import type { ReviewLine } from '../../api/gen/ReviewLine';
import type { ReviewSummary } from '../../api/gen/ReviewSummary';
import type { SquashOption } from '../../api/gen/SquashOption';
import type { WriteAccess } from '../../api/gen/WriteAccess';
import type { Json } from './fakeGitlab';
import { commentableLines, lineCode } from './review';

// --- serde_json's indexing and accessors ---
/** `v["a"]["b"]…`: a missing key, or a non-object, is null. */
function at(v: unknown, ...keys: string[]): unknown {
  let cur = v;
  for (const k of keys) cur = cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Json)[k] ?? null : null;
  return cur;
}
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** `as_u64`: a non-negative whole number. */
const u64 = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** `text`: a non-empty string, or none. */
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** `time::parse_rfc3339`: `2026-10-04T12:00:00Z`, with an optional fraction and `Z` or a `±hh:mm` offset, to unix seconds. */
export function parseRfc3339(s: string): number | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)[Tt ](\d\d):(\d\d):(\d\d)(?:\.\d*)?(?:|[Zz]|([+-])(\d+):(\d+))$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null;
  let offset = 0;
  if (m[7]) {
    const [oh, om] = [Number(m[8]), Number(m[9])];
    if (oh > 23 || om > 59) return null;
    offset = (m[7] === '+' ? 1 : -1) * (oh * 3600 + om * 60);
  }
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, se, 0);
  return Math.floor(date.getTime() / 1000) - offset;
}
const time = (v: unknown): number | null => (typeof v === 'string' ? parseRfc3339(v) : null);

// --- types.rs / stack.rs helpers the module uses ---
export const MARK_START = '<!-- gitvolt-stack:start -->';
export const MARK_END = '<!-- gitvolt-stack:end -->';

/** `stack::carries_stack_table`: a start marker with an end marker after it. */
export function carriesStackTable(description: string): boolean {
  const s = description.indexOf(MARK_START);
  return s >= 0 && description.slice(s + MARK_START.length).includes(MARK_END);
}

/** `types::label_color`: `#rrggbb`, lowercase, from GitHub's `ededed`, GitLab's `#428BCA` or `#fff`. */
export function labelColor(raw: string): string | null {
  const hex = raw.trim().replace(/^#+/, '');
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  const full = hex.length === 6 ? hex : hex.length === 3 ? [...hex].map((c) => c + c).join('') : null;
  return full === null ? null : `#${full.toLowerCase()}`;
}

/** `types::labels_of`: names (GitLab's plain list) or objects with `name` and `color`. */
export function labelsOf(v: unknown): { names: string[]; colors: Record<string, string> } {
  const names: string[] = [];
  const colors: Record<string, string> = {};
  for (const l of arr(v)) {
    const name = str(l) ?? str(at(l, 'name'));
    if (name === null) continue;
    const c = str(at(l, 'color'));
    const color = c === null ? null : labelColor(c);
    if (color !== null) colors[name] = color;
    names.push(name);
  }
  return { names, colors };
}

const GITHUB_REACTIONS = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'];

/** `types::group_reactions`: by name in first-seen order (GitHub's: its own order), `(name, user id, display name)` each. */
export function groupReactions(items: Iterable<[string, number, string]>, me: number | null, github: boolean): ForgeReaction[] {
  const out: ForgeReaction[] = [];
  for (const [name, id, who] of items) {
    let r = out.find((x) => x.name === name);
    if (!r) out.push((r = { name, count: 0, mine: false, users: [] }));
    r.count += 1;
    r.mine ||= me === id;
    r.users.push(who);
  }
  if (github) out.sort((a, b) => (GITHUB_REACTIONS.indexOf(a.name) + 1 || Infinity) - (GITHUB_REACTIONS.indexOf(b.name) + 1 || Infinity));
  return out;
}

// --- `pub mod json` ---
export function user(v: unknown): ForgeUser | null {
  const username = str(at(v, 'username'));
  const id = u64(at(v, 'id'));
  if (username === null || id === null) return null;
  return { id, username, name: text(at(v, 'name')) ?? username, avatarUrl: text(at(v, 'avatar_url')), webUrl: str(at(v, 'web_url')) ?? '', email: text(at(v, 'public_email')) ?? text(at(v, 'email')) };
}

export function project(host: string, v: Json): ForgeProject | null {
  const path = str(v.path_with_namespace);
  const id = u64(v.id);
  if (path === null || id === null) return null;
  const slash = path.lastIndexOf('/');
  return {
    kind: 'gitlab', id, host, name: str(v.name) ?? '', owner: text(at(v, 'namespace', 'full_path')) ?? (slash >= 0 ? path.slice(0, slash) : ''), webUrl: str(v.web_url) ?? '',
    defaultBranch: text(v.default_branch), cloneHttps: str(v.http_url_to_repo) ?? '', cloneSsh: str(v.ssh_url_to_repo) ?? '', forkOf: text(at(v, 'forked_from_project', 'path_with_namespace')),
    updatedAt: time(v.last_activity_at), archived: bool(v.archived) ?? false, ownerAvatarUrl: text(at(v, 'namespace', 'avatar_url')), path,
  };
}

export function settings(v: Json): ForgeProjectSettings {
  const method: MergeMethod = v.merge_method === 'rebase_merge' ? 'semiLinear' : v.merge_method === 'ff' ? 'fastForward' : 'merge';
  const squash: SquashOption = v.squash_option === 'never' ? 'never' : v.squash_option === 'always' ? 'always' : v.squash_option === 'default_on' ? 'defaultOn' : 'defaultOff';
  return { mergeMethods: [method], squash, deleteSourceBranch: bool(v.remove_source_branch_after_merge) ?? false };
}

/** `token_write`: the `api` scope. */
export function tokenWrite(v: Json): WriteAccess {
  return arr(v.scopes).includes('api') ? { kind: 'yes' } : { kind: 'no', missing: 'api' };
}

/** The prefixes GitLab reads as "draft" (and the older "WIP"), any case. */
const DRAFT_PREFIXES = ['draft:', '[draft]', '(draft)', 'draft -', 'wip:', '[wip]'];

export function stripDraft(title: string): string {
  const t = title.trimStart();
  const lower = t.replace(/[A-Z]/g, (c) => c.toLowerCase()); // to_ascii_lowercase
  for (const p of DRAFT_PREFIXES) if (lower.startsWith(p)) return t.slice(p.length).trimStart();
  return t;
}

export function mrState(state: string, draft: boolean): MrState | null {
  return state === 'opened' ? (draft ? 'draft' : 'open') : state === 'merged' ? 'merged' : state === 'locked' ? 'merging' : state === 'closed' ? 'closed' : null;
}

export function pipelineStatus(s: string): PipelineStatus | null {
  if (['created', 'waiting_for_resource', 'preparing', 'pending', 'scheduled', 'waiting_for_callback'].includes(s)) return 'pending';
  if (s === 'canceled' || s === 'canceling') return 'canceled';
  return (['running', 'success', 'failed', 'skipped', 'manual'] as const).find((x) => x === s) ?? null;
}

export function pipeline(v: unknown): ForgePipeline | null {
  const s = str(at(v, 'status'));
  const status = s === null ? null : pipelineStatus(s);
  return status === null ? null : { status, webUrl: text(at(v, 'web_url')) };
}

/** `/pipelines` (newest first) to each commit's newest pipeline. */
export function pipelinesBySha(v: unknown): Map<string, ForgePipeline> {
  const out = new Map<string, ForgePipeline>();
  for (const p of arr(v)) {
    const sha = str(at(p, 'sha'));
    const pl = pipeline(p);
    if (sha !== null && pl !== null && !out.has(sha)) out.set(sha, pl);
  }
  return out;
}

export function users(v: unknown): ForgeUser[] {
  return arr(v).map(user).filter((u): u is ForgeUser => u !== null);
}

const ids = (v: unknown): number[] => arr(v).map((u) => u64(at(u, 'id'))).filter((n): n is number => n !== null);

/** `people_body`: an edit's people as the PUT's `reviewer_ids` / `assignee_ids`: the whole lists, each change applied to the MR's `current` ones; an unchanged one isn't sent. */
export function peopleBody(current: Json, edit: MrEdit): Record<string, number[]> {
  const body: Record<string, number[]> = {};
  for (const [key, field, change] of [['reviewer_ids', 'reviewers', edit.reviewers], ['assignee_ids', 'assignees', edit.assignees]] as const) {
    if (change && (change.add.length > 0 || change.remove.length > 0)) {
      const out = ids(current[field]).filter((id) => !change.remove.includes(id)); // PeopleEdit::apply
      for (const id of change.add) if (!out.includes(id)) out.push(id);
      body[key] = out;
    }
  }
  return body;
}

/** `not_added`: of `wanted`, the ids the MR's `field` doesn't have after the PUT. */
export function notAdded(answer: Json, field: string, wanted: number[]): number[] {
  const have = ids(answer[field]);
  return wanted.filter((id) => !have.includes(id));
}

/** `mr`: one MR from a list or a GET. `target`: the project's path; `source`: its source project's. */
export function mr(v: Json, target: string, source: string): ForgeMr | null {
  const draft = bool(v.draft) ?? bool(v.work_in_progress) ?? false;
  const raw = str(v.title);
  const number = u64(v.iid);
  const rawState = str(v.state);
  const state = rawState === null ? null : mrState(rawState, draft);
  const author = user(v.author);
  const sourceBranch = str(v.source_branch);
  const targetBranch = str(v.target_branch);
  if (raw === null || number === null || state === null || author === null || sourceBranch === null || targetBranch === null) return null;
  const labels = labelsOf(v.labels);
  const description = str(v.description);
  return {
    number, title: draft ? stripDraft(raw) : raw, state, author, sourceProject: source, sourceBranch, targetProject: target, targetBranch, headSha: text(v.sha), webUrl: str(v.web_url) ?? '',
    pipeline: pipeline(v.head_pipeline), review: { decision: 'none', approvals: 0, approvalsRequired: null, reviews: [] }, conflicts: bool(v.has_conflicts), labels: labels.names, labelColors: labels.colors,
    updatedAt: time(v.updated_at) ?? 0, stacked: description !== null && carriesStackTable(description), autoMerge: autoMerge(v),
  };
}

/** `auto_merge`: set to merge when the pipeline succeeds, by `merge_user`. Only while open: a merged MR keeps the flag. */
export function autoMerge(v: Json): AutoMerge | null {
  const set = v.merge_when_pipeline_succeeds === true || v.auto_merge_enabled === true;
  return set && v.state === 'opened' ? { enabledBy: user(v.merge_user), method: null } : null;
}

/** `DETAILED_MERGE_STATUSES`: every `detailed_merge_status` GitLab documents. */
export const DETAILED_MERGE_STATUSES = [
  'mergeable', 'checking', 'unchecked', 'preparing', 'approvals_syncing', 'ci_must_pass', 'ci_still_running', 'discussions_not_resolved', 'draft_status', 'not_approved', 'requested_changes', 'conflict',
  'need_rebase', 'blocked_status', 'merge_request_blocked', 'not_open', 'broken_status', 'external_status_checks', 'status_checks_must_pass', 'jira_association_missing', 'merge_time',
  'security_policy_violations', 'policies_denied', 'locked_paths', 'locked_lfs_files', 'title_regex', 'commits_status',
];

const BLOCKED: Record<string, string> = {
  ci_must_pass: 'The pipeline must succeed first', ci_still_running: 'The pipeline is still running', discussions_not_resolved: 'Resolve all threads first',
  draft_status: "Mark it ready first: it's a draft", not_approved: 'It needs approval first', requested_changes: 'A reviewer requested changes',
  conflict: 'It has conflicts: rebase or merge the target branch first', need_rebase: 'Rebase the source branch first', blocked_status: 'Another merge request blocks it',
  merge_request_blocked: 'Another merge request blocks it', not_open: "It isn't open", broken_status: "The source branch can't be merged as it is",
  external_status_checks: 'External status checks must pass first', status_checks_must_pass: 'External status checks must pass first',
  jira_association_missing: 'Its title or description needs a Jira issue key', merge_time: "It can't merge before its scheduled time",
  security_policy_violations: 'Security policies block it', policies_denied: 'Security policies block it', locked_paths: 'Locked files block it',
  locked_lfs_files: 'Locked files block it', title_regex: "Its title doesn't match the project's rule", commits_status: "Its commits don't meet the project's rules",
};

/** `merge_status`: why GitLab won't merge it (`detailed_merge_status`, GitLab 15.6+; `merge_status` before). */
export function mergeStatus(v: Json): MergeStatus {
  const blocked = (reason: string): MergeStatus => ({ kind: 'blocked', reason });
  if (v.state === 'merged') return blocked("It's merged already");
  if (v.state === 'locked') return blocked("It's being merged");
  if (v.state === 'closed') return blocked("It's closed");
  const d = str(v.detailed_merge_status);
  if (d !== null) {
    if (d === 'mergeable') return { kind: 'mergeable' };
    if (['checking', 'unchecked', 'preparing', 'approvals_syncing'].includes(d)) return { kind: 'checking' };
    return blocked(BLOCKED[d] ?? `GitLab says: ${d.replaceAll('_', ' ')}`);
  }
  if (v.merge_status === 'can_be_merged') return { kind: 'mergeable' };
  if (v.merge_status === 'cannot_be_merged' || v.merge_status === 'cannot_be_merged_recheck') return blocked('It has conflicts: rebase or merge the target branch first');
  return { kind: 'checking' };
}

/** `review`: the approvals (`/approvals`, any tier) and the review decision. */
export function review(v: Json, approvals: Json | null): ReviewSummary {
  const reviews: ForgeReview[] = approvals ? arr(approvals.approved_by).map((x) => user(at(x, 'user'))).filter((u): u is ForgeUser => u !== null).map((u) => ({ user: u, state: 'approved', submittedAt: null })) : [];
  const n = approvals ? u64(approvals.approvals_required) : null;
  const required = n !== null && n > 0 ? n : null;
  const count = reviews.length;
  const decision: ReviewSummary['decision'] =
    v.detailed_merge_status === 'requested_changes' ? 'changesRequested' : (required === null ? count > 0 : count >= required) ? 'approved' : required !== null || arr(v.reviewers).length > 0 ? 'reviewRequired' : 'none';
  return { decision, approvals: count, approvalsRequired: required, reviews };
}

export function detail(v: Json, target: string, source: string, approvals: Json | null): ForgeMrDetail | null {
  const m = mr(v, target, source);
  if (!m) return null;
  m.review = review(v, approvals);
  const base = text(at(v, 'diff_refs', 'base_sha'));
  const subscribed = bool(v.subscribed);
  const merged = v.state === 'merged' ? (text(v.merge_commit_sha) ?? text(v.squash_commit_sha)) : null;
  return {
    mr: m, description: str(v.description) ?? '', reviewers: users(v.reviewers), assignees: users(v.assignees), mergeStatus: mergeStatus(v), squash: bool(v.squash), deleteSourceBranch: bool(v.force_remove_source_branch),
    ...(base !== null ? { baseSha: base } : {}), ...(subscribed !== null ? { subscribed } : {}), ...(merged !== null ? { mergedSha: merged } : {}),
  };
}

/** `update_offer`: Rebase, offered while it's open; a fork's branch only when the token's user (`me`) may push to it. */
export function updateOffer(v: Json, me: number | null): BranchUpdateOffer | null {
  if (v.state !== 'opened') return null;
  const n = u64(v.diverged_commits_count);
  const behind = n !== null && n > 0 ? n : null;
  const inProgress = v.rebase_in_progress === true;
  const forgeBehind = behind !== null || v.detailed_merge_status === 'need_rebase';
  const fork = u64(v.source_project_id) !== u64(v.target_project_id);
  const mayPush = !fork || v.allow_collaboration === true || me === null || u64(at(v, 'author', 'id')) === me;
  return mayPush ? { behind, forgeBehind, kinds: ['rebase', 'rebaseSkipCi'], inProgress } : null;
}

/** `people_limits`: from GraphQL's `allowsMultipleReviewers` / `allowsMultipleAssignees`: false is one. */
export function peopleLimits(answer: Json): PeopleLimits {
  const m = arr(at(answer, 'data', 'project', 'mergeRequests', 'nodes'))[0];
  const one = (k: string) => (at(m, k) === false ? 1 : null);
  return { maxReviewers: one('allowsMultipleReviewers'), maxAssignees: one('allowsMultipleAssignees') };
}

/** `kept_only`: GitLab Free keeps only the first id of a list (`sent`): with more than one sent and one kept, the one kept. */
export function keptOnly(answer: Json, field: string, sent: number): ForgeUser | null {
  const list = answer[field];
  if (!Array.isArray(list)) return null;
  return sent > 1 && list.length === 1 ? user(list[0]) : null;
}

/** `mutation_ok`: a GraphQL mutation `name` went in: no top-level errors, and none of its own. */
export function mutationOk(answer: Json, name: string): boolean {
  const empty = (e: unknown) => !Array.isArray(e) || e.length === 0;
  const m = at(answer, 'data', name);
  return empty(answer.errors) && m !== null && typeof m === 'object' && !Array.isArray(m) && empty((m as Json).errors);
}

/** `position`: a note's (or draft's) place in the diff, with a multi-line note's `line_range`. */
function position(v: unknown): DiffPosition | null {
  const path = text(at(v, 'new_path')) ?? text(at(v, 'old_path'));
  if (path === null) return null;
  const oldRaw = text(at(v, 'old_path'));
  const oldPath = oldRaw !== null && oldRaw !== path ? oldRaw : null;
  const [line, oldLine] = [u64(at(v, 'new_line')), u64(at(v, 'old_line'))];
  // A multi-line note's `line_range` (it ends at `new_line` / `old_line`); one that starts where it ends is a single line.
  const s = at(v, 'line_range', 'start');
  const from: [number | null, number | null] = [u64(at(s, 'new_line')), u64(at(s, 'old_line'))];
  const [startLine, startOldLine] = from[0] === line && from[1] === oldLine ? [null, null] : from;
  const headSha = text(at(v, 'head_sha'));
  return { path, oldPath, line, oldLine, snippet: null, startLine, startOldLine, ...(headSha !== null ? { headSha } : {}) };
}

export function note(v: Json): ForgeNote | null {
  const n = u64(v.id);
  const id = n !== null ? String(n) : text(v.id);
  const author = user(v.author);
  if (id === null || author === null) return null;
  return { id, author, body: str(v.body) ?? '', createdAt: time(v.created_at) ?? 0, system: bool(v.system) ?? false, position: position(v.position) };
}

/** `gid_number`: the number at the end of a GraphQL global id (`gid://gitlab/Note/101`). */
export function gidNumber(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const last = s.slice(s.lastIndexOf('/') + 1);
  return /^\+?\d+$/.test(last) ? Number(last) : null;
}

/** `awards`: a note's award emoji (REST `award_emoji`: `name` and `user`), grouped. */
export function awards(list: Json[], me: number | null): ForgeReaction[] {
  const who = (a: unknown) => text(at(a, 'user', 'name')) ?? str(at(a, 'user', 'username')) ?? '';
  const items: [string, number, string][] = [];
  for (const a of list) {
    const name = str(at(a, 'name'));
    const id = u64(at(a, 'user', 'id')) ?? gidNumber(at(a, 'user', 'id'));
    if (name !== null && id !== null) items.push([name, id, who(a)]);
  }
  return groupReactions(items, me, false);
}

/** `note_awards`: one page of `NOTE_AWARDS_QUERY`: each note's (by id) award emoji, and the next page's cursor. Null: GitLab couldn't answer it. */
export function noteAwards(answer: Json, me: number | null): { notes: [string, ForgeReaction[]][]; next: string | null } | null {
  if (arr(answer.errors).length > 0) return null;
  const notes = at(answer, 'data', 'project', 'mergeRequest', 'notes');
  const nodes = at(notes, 'nodes');
  if (!Array.isArray(nodes)) return null;
  const out: [string, ForgeReaction[]][] = [];
  for (const n of nodes) {
    const id = gidNumber(at(n, 'id'));
    if (id === null) continue;
    const list = arr(at(n, 'awardEmoji', 'nodes')) as Json[];
    if (list.length > 0) out.push([String(id), awards(list, me)]);
  }
  const next = at(notes, 'pageInfo', 'hasNextPage') === true ? str(at(notes, 'pageInfo', 'endCursor')) : null;
  return { notes: out, next };
}

export function discussion(v: Json): ForgeDiscussion | null {
  if (!Array.isArray(v.notes) || v.notes.length === 0) return null;
  const raw = v.notes as unknown[];
  const first = raw[0];
  const notes = raw.map((n) => note(obj(n))).filter((n): n is ForgeNote => n !== null);
  if (notes.length === 0) return null;
  const resolved = at(first, 'resolved') === true;
  // Each of a resolved discussion's notes names who resolved it.
  const by = raw.map((n) => text(at(n, 'resolved_by', 'name')) ?? str(at(n, 'resolved_by', 'username'))).find((s) => s !== null) ?? null;
  const resolvedAt = raw.map((n) => time(at(n, 'resolved_at'))).find((t) => t !== null) ?? null;
  return {
    id: str(v.id) ?? '', notes, resolvable: at(first, 'resolvable') === true, resolved,
    ...(resolved && by !== null ? { resolvedBy: by } : {}), ...(resolved && resolvedAt !== null ? { resolvedAt } : {}),
  };
}

/** `snippet`: up to three lines of a unified diff ending at the commented one (`newLine` on the new side, else `oldLine` on the old). */
export function snippet(diff: string, newLine: number | null, oldLine: number | null): string | null {
  return rangeSnippet(diff, [newLine, oldLine], [null, null]);
}

/** `range_snippet`: as `snippet`, for a multi-line note's (new, old) `end` and `start` lines: from the start (when it's in the end's hunk) or three lines back, whichever is earlier. */
export function rangeSnippet(diff: string, end: [number | null, number | null], start: [number | null, number | null]): string | null {
  // Asked for by its new line, else (no new line asked for) by its old one.
  const is = (kind: string | undefined, old: number, nw: number, [newLine, oldLine]: [number | null, number | null]) =>
    kind === '+' ? newLine === nw : kind === '-' ? newLine === null && oldLine === old : newLine === nw || (newLine === null && oldLine === old);
  let [old, nw] = [0, 0];
  let hunk: string[] = [];
  let first: number | null = null;
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // `str::lines`
  for (let line of lines) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('@@ ')) {
      const parts = line.slice(3).split(/\s+/).filter((p) => p !== '');
      const startOf = (p: string | undefined, sign: string) => {
        const s = p?.startsWith(sign) ? p.slice(1).split(',')[0] : undefined;
        return s !== undefined && /^\d+$/.test(s) ? Number(s) : null;
      };
      old = startOf(parts[0], '-') ?? 0;
      nw = startOf(parts[1], '+') ?? 0;
      hunk = [];
      first = null;
      continue;
    }
    if (line.startsWith('\\')) continue;
    const kind: string | undefined = line[0];
    hunk.push(line);
    const i = hunk.length - 1;
    if (first === null && is(kind, old, nw, start)) first = i;
    const hit = is(kind, old, nw, end);
    if (kind === '+') nw += 1;
    else if (kind === '-') old += 1;
    else {
      old += 1;
      nw += 1;
    }
    if (hit) {
      const from = Math.max(0, i - 2);
      return hunk.slice(first === null ? from : Math.min(first, from)).join('\n');
    }
  }
  return null;
}

/** `fill_snippets`: each diff note's snippet, from the MR's diffs (`/diffs`: `new_path`, `old_path`, `diff`). */
export function fillSnippets(ds: ForgeDiscussion[], diffs: Json[]): void {
  for (const n of ds.flatMap((d) => d.notes)) {
    const pos = n.position;
    if (!pos || pos.snippet !== null) continue;
    const d = diffs.find((x) => x.new_path === pos.path || x.old_path === pos.path);
    const diff = d ? str(d.diff) : null;
    pos.snippet = diff === null ? null : rangeSnippet(diff, [pos.line, pos.oldLine], [pos.startLine, pos.startOldLine]);
  }
}

/** `pick_for_branch`: a branch's badge: its open (or draft) MR, else its most recently updated one. */
export function pickForBranch(mrs: ForgeMr[]): ForgeMr | null {
  const open = mrs.find((m) => m.state === 'open' || m.state === 'draft');
  if (open) return open;
  let best: ForgeMr | null = null;
  for (const m of mrs) if (best === null || m.updatedAt >= best.updatedAt) best = m; // max_by_key keeps the last of equals
  return best;
}

export function label(v: Json): ForgeLabel | null {
  const name = str(v.name);
  return name === null ? null : { name, color: text(v.color), description: text(v.description) };
}

/** `draft_title`: GitLab's draft is the title prefix, which every version honours. */
export function draftTitle(title: string, draft: boolean): string {
  const t = title.trim();
  const lower = t.toLowerCase();
  const marked = ['draft:', '[draft]', '(draft)'].some((p) => lower.startsWith(p));
  return draft && !marked ? `Draft: ${t}` : t;
}

/** `create_body`: the POST body. A fork's MR is created in the fork (`sourceId`) and names the target. */
export function createBody(req: CreateMr, sourceId: number, targetId: number): Json {
  const b: Json = {
    source_branch: req.source.branch, target_branch: req.targetBranch, title: draftTitle(req.title, req.draft), description: req.description,
    assignee_ids: req.assignees, reviewer_ids: req.reviewers, labels: req.labels,
  };
  if (sourceId !== targetId) b.target_project_id = targetId;
  if (req.squash !== null) b.squash = req.squash;
  if (req.deleteSourceBranch !== null) b.remove_source_branch = req.deleteSourceBranch;
  return b;
}

/** `created_mr`: the MR GitLab answered a create with, under the paths it was made with. */
export function createdMr(v: Json, sourceProject: string, targetProject: string): ForgeMr | null {
  const draft = bool(v.draft) ?? bool(v.work_in_progress) ?? false;
  const raw = str(v.state);
  if (raw === null) return null;
  const state: MrState = raw === 'merged' ? 'merged' : raw === 'locked' ? 'merging' : raw === 'closed' ? 'closed' : draft ? 'draft' : 'open';
  const [number, title, author, sourceBranch, targetBranch, webUrl] = [u64(v.iid), str(v.title), user(v.author), str(v.source_branch), str(v.target_branch), str(v.web_url)];
  if (number === null || title === null || author === null || sourceBranch === null || targetBranch === null || webUrl === null) return null;
  const labels = labelsOf(v.labels);
  const description = str(v.description);
  return {
    number, title, state, author, sourceProject, sourceBranch, targetProject, targetBranch, headSha: text(v.sha), webUrl, pipeline: null,
    review: { decision: 'none', approvals: 0, approvalsRequired: null, reviews: [] }, conflicts: bool(v.has_conflicts), labels: labels.names, labelColors: labels.colors,
    updatedAt: time(v.updated_at) ?? 0, stacked: description !== null && carriesStackTable(description), autoMerge: null,
  };
}

/** `diff_refs`: a single MR's `diff_refs`; null until GitLab has worked the diff out. */
export function diffRefs(v: Json): DiffRefs | null {
  const [baseSha, startSha, headSha] = [text(at(v, 'diff_refs', 'base_sha')), text(at(v, 'diff_refs', 'start_sha')), text(at(v, 'diff_refs', 'head_sha'))];
  return baseSha === null || startSha === null || headSha === null ? null : { baseSha, startSha, headSha };
}

/** `review_files`: the MR's `/diffs`, each file with its commentable lines. `too_large` / `collapsed`: no diff came, so no line takes a comment here. */
export function reviewFiles(diffs: Json[]): ReviewFile[] {
  const out: ReviewFile[] = [];
  for (const d of diffs) {
    const path = text(d.new_path) ?? text(d.old_path);
    if (path === null) continue;
    const tooLarge = d.too_large === true || d.collapsed === true;
    out.push({ path, oldPath: text(d.old_path) ?? path, lines: tooLarge ? [] : commentableLines(str(d.diff) ?? ''), tooLarge });
  }
  return out;
}

/** `put_lines`: `old_line` / `new_line` for the sides a line is on (an added line has no old one). */
function putLines(o: Json, l: ReviewLine): void {
  if (l.kind !== 'added') o.old_line = l.oldLine;
  if (l.kind !== 'removed') o.new_line = l.newLine;
}

/** `range_end`: one end of a `line_range`: its line code, `type` ("new" for an added line, otherwise "old") and its lines. */
async function rangeEnd(path: string, l: ReviewLine): Promise<Json> {
  const o: Json = { line_code: await lineCode(path, l), type: l.kind === 'added' ? 'new' : 'old' };
  putLines(o, l);
  return o;
}

/** `position_json`: a comment's `position` (draft notes and diff threads take the same). Async: the line codes are SHA-1s. */
export async function positionJson(c: NewReviewComment): Promise<Json> {
  const a = c.anchor;
  const o: Json = { position_type: 'text', base_sha: c.refs.baseSha, start_sha: c.refs.startSha, head_sha: c.refs.headSha, old_path: a.oldPath, new_path: a.path };
  putLines(o, a.end);
  if (a.start) o.line_range = { start: await rangeEnd(a.path, a.start), end: await rangeEnd(a.path, a.end) };
  return o;
}

/** `draft`: a draft note (`/draft_notes`); one without a usable `position` is on no line. */
export function draft(v: Json): ReviewDraft | null {
  const id = u64(v.id);
  return id === null ? null : { id: String(id), body: str(v.note) ?? '', position: position(v.position), replyTo: text(v.discussion_id) };
}
