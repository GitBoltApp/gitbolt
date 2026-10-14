// GitLab's provider (gitvolt-forge/src/gitlab.rs `impl ForgeProvider`) over the fake GitLab in the
// page: each method asks the fake what the harness's would answer and maps it with gitlabJson.ts.
// No HTTP, so no ETags or rate limits, and everything is fresh; the pages the provider reads (its
// `per_page` and page caps) are kept, so a long list is cut where the core's is.
import type { CreateMr } from '../../api/gen/CreateMr';
import type { CreateOutcome } from '../../api/gen/CreateOutcome';
import type { ForgeLabel } from '../../api/gen/ForgeLabel';
import type { MrTemplate } from '../../api/gen/MrTemplate';
import type { BranchUpdate } from '../../api/gen/BranchUpdate';
import type { ForgeNote } from '../../api/gen/ForgeNote';
import type { ForgeReaction } from '../../api/gen/ForgeReaction';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { ForgePipeline } from '../../api/gen/ForgePipeline';
import type { ForgeProject } from '../../api/gen/ForgeProject';
import type { ForgeProjectSettings } from '../../api/gen/ForgeProjectSettings';
import type { ForgeUser } from '../../api/gen/ForgeUser';
import type { ForkPage } from '../../api/gen/ForkPage';
import type { GbError } from '../../api/gen/GbError';
import type { MergeOptions } from '../../api/gen/MergeOptions';
import type { MrEdit } from '../../api/gen/MrEdit';
import type { MrFilter } from '../../api/gen/MrFilter';
import type { NewNote } from '../../api/gen/NewNote';
import type { NoteRef } from '../../api/gen/NoteRef';
import type { PeopleLimits } from '../../api/gen/PeopleLimits';
import type { ReviewOutcome } from '../../api/gen/ReviewOutcome';
import type { ReviewSubmit } from '../../api/gen/ReviewSubmit';
import type { NewReviewComment } from '../../api/gen/NewReviewComment';
import type { ReviewDiff } from '../../api/gen/ReviewDiff';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';
import type { ReviewDrafts } from '../../api/gen/ReviewDrafts';
import type { SubmitOutcome } from '../../api/gen/SubmitOutcome';
import type { ThreadState } from '../../api/gen/ThreadState';
import type { SourceRef } from '../../api/gen/SourceRef';
import { gbError } from '../engine/errors';
import { lossyUtf8, utf8Bytes } from '../engine/read/bytes';
import { compareBytes } from '../engine/refs';
import { isGbError } from '../engine/read/seam';
import { redact } from '../engine/remotes';
import { FakeGitLab, FakeHttp, type Json, type MrQuery } from './fakeGitlab';
import * as j from './gitlabJson';
import { OLD_GITLAB_DRAFTS } from './review';

export const HOST = 'gitlab.example.com';
/** The core's `FORBIDDEN_MARK`. */
export const REFUSED = ' refused: ';

/** gitlab.rs's page sizes and caps. */
export const MR_PER_PAGE = 100;
export const OPEN_PAGES = 5;
export const DISCUSSION_PAGES = 5;
export const DIFF_PAGES = 3;

/** http.rs `body_message`: what a refusal's body says, redacted, at most 200 characters. */
function bodyMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const v = body as Json;
  let said: string | null = null;
  for (const k of ['error_description', 'message', 'error']) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    if (typeof x === 'string') {
      if (x.trim()) said = x.trim();
    } else if (Array.isArray(x) && x.every((s) => typeof s === 'string')) {
      const parts = (x as string[]).map((s) => s.trim()).filter(Boolean);
      if (parts.length) said = parts.join('; ');
    } else said = JSON.stringify(x);
    if (said !== null) break;
  }
  if (said === null) return null;
  const errors = Array.isArray(v.errors) ? v.errors : [];
  const detail = errors.map((e) => (typeof e === 'string' ? e : typeof (e as Json)?.message === 'string' ? ((e as Json).message as string) : null)).filter((m): m is string => m !== null).map((m) => m.trim()).filter(Boolean);
  if (detail.length) said = `${said}: ${detail.join('; ')}`;
  return [...redact(said)].slice(0, 200).join('');
}

/** gitvolt-forge's http.rs `status_error`. */
export function statusError(status: number, body: unknown): GbError {
  const s = bodyMessage(body);
  if (status === 401) return gbError('AuthFailed', `${HOST} rejected the token: add the account again in Settings › Accounts`);
  if (status === 403) return gbError('AuthFailed', `${HOST}${REFUSED}${s ?? "the token isn't allowed to do this"}`);
  if (status === 404) return gbError('NotFound', `Not found on ${HOST}`);
  if (status === 409 || status === 422) return gbError('InvalidInput', `${HOST}: ${s ?? `HTTP ${status}`}`);
  return gbError('Other', `${HOST} answered HTTP ${status}${s ? `: ${s}` : ''}`);
}

/** `ask` for an answer that takes a moment (the line codes are SHA-1s). */
export async function askAsync<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof FakeHttp) throw statusError(e.status, e.body);
    throw e;
  }
}

/** The fake's answer, its HTTP refusals as the core's errors. */
export function ask<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof FakeHttp) throw statusError(e.status, e.body);
    throw e;
  }
}

/** gitlab.rs's page caps for a review: its diff reads at most this many pages of 100 files; its drafts this many of 100. */
export const REVIEW_DIFF_PAGES = 10;
export const DRAFT_PAGES = 5;

/** gitlab.rs `line_refused`: a 400 about the position is said as a refusal of the line, any other in neutral words, both made plain where GitLab's words are a validation hash. */
export function lineRefused(e: unknown): unknown {
  if (isGbError(e) && e.kind === 'Other' && e.message.includes('HTTP 400')) {
    const i = e.message.indexOf(': ');
    const said = i < 0 ? '' : e.message.slice(i + 2);
    const lower = said.toLowerCase();
    const aboutLine = ['position', 'line_code', 'line code', 'line'].some((w) => lower.includes(w));
    const plain = plainValidation(said) ?? said;
    return gbError('InvalidInput', `${aboutLine ? "GitLab won't take a comment on that line" : 'GitLab refused the comment'}${plain === '' ? '' : ': '}${plain}`);
  }
  return e;
}

/** gitlab.rs `plain_validation`: GitLab's validation errors as Ruby prints them (`Note {:line_code=>["can't be blank"]}`, or Ruby 3.4's `{line_code: [...]}`) in plain words; null when `said` isn't one. */
export function plainValidation(said: string): string | null {
  const open = said.indexOf('{');
  const close = said.lastIndexOf('}');
  if (open < 0 || close < open) return null;
  let rest = said.slice(open + 1, close).trim();
  const parts: string[] = [];
  while (rest !== '') {
    const m = /^:?"?([A-Za-z0-9_]+)"?\s*(?:=>|:)\s*\[/.exec(rest);
    if (!m) return null;
    let list = rest.slice(m[0].length);
    const msgs: string[] = [];
    for (;;) {
      list = list.replace(/^[\s,]+/, '');
      if (list.startsWith(']')) {
        list = list.slice(1);
        break;
      }
      if (!list.startsWith('"')) return null;
      const end = list.indexOf('"', 1);
      if (end < 0) return null;
      msgs.push(list.slice(1, end));
      list = list.slice(end + 1);
    }
    if (msgs.length === 0) return null;
    parts.push(`${m[1].replaceAll('_', ' ')} ${msgs.join(', ')}`);
    rest = list.replace(/^[\s,]+/, '');
  }
  return parts.length ? parts.join('; ') : null;
}

/** gitlab.rs `unreadable`. */
const unreadable = (what: string) => gbError('Other', `${HOST} sent a ${what} GitVolt couldn't read`);

export class DemoGitLab {
  readonly fake: FakeGitLab;
  constructor(fake: FakeGitLab) {
    this.fake = fake;
  }

  /** `current_user` (`/user`): the token's user, the forge.json's `me`. */
  me(): ForgeUser {
    return j.user(this.fake.userJson(this.fake.person(this.fake.me))) ?? fail(unreadable('user'));
  }

  project(path: string): ForgeProject {
    return ask(() => j.project(HOST, this.fake.projectJson(this.fake.project(path))) ?? fail(unreadable('project')));
  }

  projectSettings(p: ForgeProject): ForgeProjectSettings {
    return ask(() => j.settings(this.fake.projectJson(this.fake.project(p.id))));
  }

  /** `forks_page`: the harness's `/forks` (newest activity first) paged by `per_page` and `page`. */
  forksPage(p: ForgeProject, page: number, perPage: number): ForkPage {
    return ask(() => {
      const parent = this.fake.project(p.id);
      const all = this.fake.seed.projects.filter((x) => x.forkOf === parent.path).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      const start = (page - 1) * perPage;
      const forks = all.slice(start, start + perPage).flatMap((x) => j.project(HOST, this.fake.projectJson(x)) ?? []);
      return { forks, next: start + perPage < all.length ? page + 1 : null };
    });
  }

  /** `source_of`: an MR's source project path; one the fake doesn't know is named by id. */
  private sourceOf(p: ForgeProject, v: Json): string {
    const id = v.source_project_id;
    if (typeof id !== 'number') return p.path;
    if (id === p.id) return p.path;
    return this.fake.seed.projects.find((x) => x.id === id)?.path ?? `project ${id}`;
  }

  /** `mrs_of`: each listed MR mapped, its head's pipeline from `pipelines` when it came without. */
  private mrsOf(p: ForgeProject, list: Json[], pipelines: Map<string, ForgePipeline>): ForgeMr[] {
    return list.flatMap((v) => {
      const m = j.mr(v, p.path, this.sourceOf(p, v));
      if (!m) return [];
      if (m.pipeline === null && m.headSha !== null) m.pipeline = pipelines.get(m.headSha) ?? null;
      return [m];
    });
  }

  /** `list_open`: the open MRs for `filter`, newest activity first. With pipelines (the list) one
   * page; without (the badges) up to `OPEN_PAGES`. */
  openMrs(p: ForgeProject, filter: MrFilter, withPipelines: boolean): ForgeMr[] {
    const q: MrQuery = { state: 'opened', ...(filter === 'mine' ? { scope: 'created_by_me' as const } : filter === 'reviewRequested' ? { reviewerId: this.me().id } : {}) };
    const list = ask(() => this.fake.listMrs(this.fake.project(p.id).path, q)).slice(0, MR_PER_PAGE * (withPipelines ? 1 : OPEN_PAGES));
    const pipelines = withPipelines && list.some((v) => typeof v.sha === 'string') ? j.pipelinesBySha(this.fake.pipelinesJson(p.path)) : new Map<string, ForgePipeline>();
    return this.mrsOf(p, list, pipelines);
  }

  /** `open_mrs_targeting`: one page of 100. */
  openMrsTargeting(p: ForgeProject, branch: string): ForgeMr[] {
    const list = ask(() => this.fake.listMrs(this.fake.project(p.id).path, { state: 'opened', targetBranch: branch })).slice(0, 100);
    return this.mrsOf(p, list, new Map());
  }

  /** `mr_for_branch`: the newest 20 in any state from `source.branch`, those from `source.project`, picked. */
  mrForBranch(p: ForgeProject, source: SourceRef): ForgeMr | null {
    const list = ask(() => this.fake.listMrs(this.fake.project(p.id).path, { state: 'all', sourceBranch: source.branch })).slice(0, 20);
    return j.pickForBranch(this.mrsOf(p, list, new Map()).filter((m) => m.sourceProject === source.project));
  }

  /** `mr_detail`: the MR with its approvals, its branch update offer and its labels' colours. */
  mrDetail(p: ForgeProject, n: number): ForgeMrDetail {
    return ask(() => {
      const v = this.fake.getMr(p.path, n, { diverged: true, rebaseInProgress: true });
      const approvals = this.fake.approvalsJson(this.fake.mr(p.path, n));
      const d = j.detail(v, p.path, this.sourceOf(p, v), approvals) ?? fail(unreadable('merge request'));
      // A fork's branch is pushed to by its author (asked only then).
      const fork = v.source_project_id !== v.target_project_id;
      const update = j.updateOffer(v, fork ? this.me().id : null);
      if (update !== null) d.update = update;
      this.fillLabelColors(p, d.mr);
      return d;
    });
  }

  /** `fill_label_colors`: a single MR's GET names its labels only; their colours from the project's. */
  private fillLabelColors(p: ForgeProject, mr: ForgeMr): void {
    const wanted = mr.labels.filter((l) => !(l in mr.labelColors));
    if (wanted.length === 0) return;
    const colors = new Map<string, string>();
    for (const l of this.fake.labelsJson(p.id).flatMap((x) => j.label(x) ?? [])) {
      const c = l.color === null ? null : j.labelColor(l.color);
      if (c !== null) colors.set(l.name, c);
    }
    for (const l of wanted) {
      const c = colors.get(l);
      if (c !== undefined) mr.labelColors[l] = c;
    }
  }

  /** `discussions`: oldest first, diff notes with their snippets, every note with its award emoji. */
  discussions(p: ForgeProject, n: number): ForgeDiscussion[] {
    return ask(() => {
      const m = this.fake.mr(p.path, n);
      const ds = m.discussions.slice(0, MR_PER_PAGE * DISCUSSION_PAGES).flatMap((d) => j.discussion(this.fake.discussionJson(d)) ?? []);
      if (ds.some((d) => d.notes.some((x) => x.position !== null))) j.fillSnippets(ds, this.fake.diffsJson(m).slice(0, MR_PER_PAGE * DIFF_PAGES));
      this.fillAwards(p, n, ds);
      return ds;
    });
  }

  /** `fill_awards`: from GraphQL's every note's award emoji, best effort. The fake answers every
   * note in one page (no next cursor), so one read is all the core's loop makes of it. */
  private fillAwards(p: ForgeProject, n: number, ds: ForgeDiscussion[]): void {
    if (!ds.some((d) => d.notes.some((x) => !x.system))) return;
    const answer = j.noteAwards(this.fake.noteAwardsJson(p.path, n), this.me().id);
    if (answer === null) return;
    const found = new Map(answer.notes);
    for (const note of ds.flatMap((d) => d.notes)) {
      const r = found.get(note.id);
      if (r !== undefined) {
        note.reactions = r;
        found.delete(note.id);
      }
    }
  }

  /** `people_limits`: GraphQL's people flags. */
  peopleLimits(p: ForgeProject): PeopleLimits {
    return j.peopleLimits(this.fake.peopleFlags(p.path));
  }

  /** `note_url`'s id check: a note's id is digits. */
  private noteId(note: NoteRef): string {
    if (!/^\d+$/.test(note.note)) throw gbError('InvalidInput', 'GitLab has no such comment');
    return note.note;
  }

  /** `reply`: a note in `note.discussion`, or a new discussion. */
  reply(p: ForgeProject, n: number, note: NewNote): ForgeNote {
    return ask(() => j.note(this.fake.addNote(p.path, n, note.discussion, note.body)) ?? fail(unreadable('note')));
  }

  approve(p: ForgeProject, n: number): void {
    ask(() => this.fake.approve(p.path, n));
  }

  /** `request_changes_steps`: the comment (when there's a body), the user's approval withdrawn (not
   * approved is fine), then with `setState` the reviewer state set to requested changes. */
  requestChangesSteps(p: ForgeProject, n: number, body: string, setState: boolean, out: SubmitOutcome): void {
    if (body.trim() !== '') {
      ask(() => this.fake.addNote(p.path, n, null, body));
      out.bodyPosted = true;
    }
    try {
      ask(() => this.fake.unapprove(p.path, n));
    } catch (e) {
      if (!(isGbError(e) && e.kind === 'NotFound')) throw e;
    }
    out.eventSent = true;
    if (setState) out.fallback = !j.mutationOk(this.fake.requestChanges(p.path, n), 'mergeRequestRequestChanges');
  }

  /** `review`: Request changes is the steps with the state set; Comment and Approve are `review_by_parts`. */
  review(p: ForgeProject, n: number, r: ReviewSubmit): ReviewOutcome {
    if (r.event === 'requestChanges') {
      const out: SubmitOutcome = { published: 0, eventError: null, bodyPosted: false, eventSent: false, fallback: false };
      this.requestChangesSteps(p, n, r.body, true, out);
      return { fallback: out.fallback };
    }
    if (r.event === 'comment') this.reply(p, n, { discussion: null, body: r.body });
    else {
      this.approve(p, n);
      if (r.body.trim() !== '') this.reply(p, n, { discussion: null, body: r.body });
    }
    return { fallback: false };
  }

  /** `set_subscribed`: GitLab's 304 (already so) is `on`. */
  setSubscribed(p: ForgeProject, n: number, on: boolean): boolean {
    const v = ask(() => this.fake.subscribe(p.path, n, on));
    return v === null ? on : typeof v.subscribed === 'boolean' ? v.subscribed : on;
  }

  /** `react`: the note's awards read first, then the one asked for added or removed unless it's so already. */
  react(p: ForgeProject, n: number, note: NoteRef, name: string, on: boolean): ForgeReaction[] {
    const id = this.noteId(note);
    const me = this.me().id;
    return ask(() => {
      let list = this.fake.noteAwards(p.path, n, id);
      const mine = list.findIndex((a) => a.name === name && (a.user as Json).id === me);
      if (on && mine < 0) list = [...list, this.fake.award(p.path, n, id, name)];
      else if (!on && mine >= 0) {
        if (typeof list[mine].id !== 'number') throw unreadable('reaction');
        this.fake.unaward(p.path, n, id, list[mine].id);
        list = list.filter((_, i) => i !== mine);
      }
      return j.awards(list, me);
    });
  }

  editNote(p: ForgeProject, n: number, note: NoteRef, body: string): ForgeNote {
    const id = this.noteId(note);
    return ask(() => j.note(this.fake.editNote(p.path, n, id, body)) ?? fail(unreadable('note')));
  }

  deleteNote(p: ForgeProject, n: number, note: NoteRef): void {
    const id = this.noteId(note);
    ask(() => this.fake.deleteNote(p.path, n, id));
  }

  resolve(p: ForgeProject, n: number, discussion: string, resolved: boolean): ThreadState {
    const d = ask(() => j.discussion(this.fake.resolve(p.path, n, discussion, resolved)) ?? fail(unreadable('discussion')));
    return { resolved: d.resolved, resolvedBy: d.resolvedBy ?? null };
  }

  // --- review comments ---

  /** `review_diff`: the MR's diff refs and its files with their commentable lines. */
  reviewDiff(p: ForgeProject, n: number): ReviewDiff {
    return ask(() => {
      const v = this.fake.getMr(p.path, n, { diverged: false, rebaseInProgress: false });
      const refs = j.diffRefs(v) ?? fail(gbError('InvalidInput', `GitLab hasn't worked out !${n}'s diff yet: try again in a moment`));
      return { refs, files: j.reviewFiles(this.fake.diffsJson(this.fake.mr(p.path, n)).slice(0, MR_PER_PAGE * REVIEW_DIFF_PAGES)) };
    });
  }

  /** `review_drafts`: the user's drafts (a pending review is GitHub's). */
  reviewDrafts(p: ForgeProject, n: number): ReviewDrafts {
    return ask(() => {
      const v = this.fake.getMr(p.path, n, { diverged: false, rebaseInProgress: false });
      const list = this.fake.drafts(p.path, n).slice(0, MR_PER_PAGE * DRAFT_PAGES);
      return { refs: j.diffRefs(v), drafts: list.flatMap((d) => j.draft(d) ?? []), pendingReview: null, canDraft: true };
    });
  }

  /** `add_draft`: a draft note with the comment's position; one the forge kept without it is taken back and refused. */
  async addDraft(p: ForgeProject, n: number, comment: NewReviewComment): Promise<ReviewDraft> {
    let raw: Json;
    try {
      raw = await askAsync(async () => this.fake.addDraft(p.path, n, comment.body, await j.positionJson(comment)));
    } catch (e) {
      throw lineRefused(e);
    }
    const d = j.draft(raw) ?? fail(unreadable('draft note'));
    if (d.position === null) {
      try {
        ask(() => this.fake.deleteDraft(p.path, n, d.id));
      } catch {
        // Kept without its line, as the core says in its log.
      }
      throw gbError('InvalidInput', OLD_GITLAB_DRAFTS);
    }
    return d;
  }

  /** `draft_url`'s id check: a draft's id is digits. */
  private draftId(id: string): string {
    if (!/^\d+$/.test(id)) throw gbError('InvalidInput', 'GitLab has no such draft');
    return id;
  }

  /** `edit_draft`: no position in the answer; the caller keeps its own. */
  editDraft(p: ForgeProject, n: number, id: string, body: string): ReviewDraft {
    const did = this.draftId(id);
    const d = ask(() => j.draft(this.fake.editDraft(p.path, n, did, body)) ?? fail(unreadable('draft note')));
    return { ...d, position: null };
  }

  deleteDraft(p: ForgeProject, n: number, id: string): void {
    const did = this.draftId(id);
    ask(() => this.fake.deleteDraft(p.path, n, did));
  }

  /** `submit_review`: bulk publish, then the event as the composer sends it, part by part; once the drafts are in, a refused event is said in the outcome, not as a failure. */
  async submitReview(p: ForgeProject, n: number, review: ReviewSubmit): Promise<SubmitOutcome> {
    await askAsync(() => this.fake.publishDrafts(p.path, n));
    const out: SubmitOutcome = { published: 0, eventError: null, bodyPosted: false, eventSent: false, fallback: false };
    const hasBody = review.body.trim() !== '';
    if (review.event === 'comment' && !hasBody) return out;
    const note = { discussion: null, body: review.body };
    try {
      if (review.event === 'comment') {
        this.reply(p, n, note);
        out.bodyPosted = true;
        out.eventSent = true;
      } else if (review.event === 'approve') {
        this.approve(p, n);
        out.eventSent = true;
        if (hasBody) {
          this.reply(p, n, note);
          out.bodyPosted = true;
        }
      } else this.requestChangesSteps(p, n, review.body, true, out);
    } catch (e) {
      if (!isGbError(e)) throw e;
      out.eventError = e.message;
    }
    return out;
  }

  /** `discard_review`: every draft of the user's deleted; how many. */
  discardReview(p: ForgeProject, n: number): number {
    const ids = ask(() => this.fake.drafts(p.path, n)).slice(0, MR_PER_PAGE * DRAFT_PAGES).flatMap((d) => (typeof d.id === 'number' ? [d.id] : []));
    ids.forEach((id, done) => {
      try {
        ask(() => this.fake.deleteDraft(p.path, n, String(id)));
      } catch (e) {
        if (!isGbError(e)) throw e;
        throw gbError(e.kind, `Deleted ${done} of ${ids.length} pending comments: ${e.message}`);
      }
    });
    return ids.length;
  }

  /** `comment_now`: a diff thread at once. */
  async commentNow(p: ForgeProject, n: number, comment: NewReviewComment): Promise<ForgeDiscussion> {
    let raw: Json;
    try {
      raw = await askAsync(async () => this.fake.addDiffThread(p.path, n, comment.body, await j.positionJson(comment)));
    } catch (e) {
      throw lineRefused(e);
    }
    return j.discussion(raw) ?? fail(unreadable('discussion'));
  }
  // --- end review comments ---

  // --- merging, auto-merge, GitLab's rebase and edits ---

  /** `mr_from`: an MR JSON the fake answered a write with. */
  private mrFrom(p: ForgeProject, v: Json): ForgeMr {
    return j.mr(v, p.path, this.sourceOf(p, v)) ?? fail(unreadable('merge request'));
  }

  /** A write's request: its HTTP refusal as the core's error, said by `refused`. */
  private send(f: () => Json, refused: (e: GbError) => GbError = (e) => e): Json {
    try {
      return ask(f);
    } catch (e) {
      throw isGbError(e) ? refused(e) : e;
    }
  }

  /** The method is the project's (GitLab merges with it); `o.method` is ignored. */
  merge(p: ForgeProject, n: number, o: MergeOptions): ForgeMr {
    return this.mrFrom(p, this.send(() => this.fake.merge(p.path, n, mergeBody(o, false)), (e) => mergeRefused(n, e)));
  }

  /** The merge PUT with the auto-merge flags: GitLab merges at once when the pipeline has passed already. */
  setAutoMerge(p: ForgeProject, n: number, o: MergeOptions): ForgeMr {
    return this.mrFrom(p, this.send(() => this.fake.merge(p.path, n, mergeBody(o, true)), (e) => autoMergeRefused(n, e)));
  }

  cancelAutoMerge(p: ForgeProject, n: number): ForgeMr {
    return this.mrFrom(p, this.send(() => this.fake.cancelAutoMerge(p.path, n), (e) => cancelRefused(n, e)));
  }

  /** `update_branch`'s PUT: GitLab's rebase, queued. */
  startRebase(p: ForgeProject, n: number, how: BranchUpdate): void {
    if (how === 'merge') throw gbError('InvalidInput', 'GitLab updates a source branch by rebasing it');
    this.send(() => {
      this.fake.rebase(p.path, n, how === 'rebaseSkipCi');
      return {};
    }, (e) => rebaseRefused(n, e));
  }

  /** `update_branch`'s polls: the MR asked `include_rebase_in_progress` until it isn't (the fake
   * says so for one read), then its `merge_error` when the rebase failed. */
  finishRebase(p: ForgeProject, n: number, expectedSha: string | null): ForgeMr {
    let v: Json = {};
    for (let i = 0; i < BRANCH_UPDATE_POLLS; i++) {
      v = ask(() => this.fake.getMr(p.path, n, { diverged: false, rebaseInProgress: true }));
      if (v.rebase_in_progress !== true) break;
    }
    const failed = rebaseFailed(n, v, expectedSha);
    if (failed !== null) throw failed;
    return this.mrFrom(p, v);
  }

  /** `edit`: a draft keeps its prefix (a new title is sent as `Draft: <title>`); the people are the
   * whole lists from the MR as it is now; someone GitLab didn't add is refused, and said as the
   * project's limit when it kept only one. */
  edit(p: ForgeProject, n: number, e: MrEdit): ForgeMr {
    const current = ask(() => this.fake.getMr(p.path, n, { diverged: false, rebaseInProgress: false }));
    const draft = (typeof current.draft === 'boolean' ? current.draft : typeof current.work_in_progress === 'boolean' ? current.work_in_progress : false) as boolean;
    const body: Json = j.peopleBody(current, e);
    if (e.title !== null) {
      const t = j.stripDraft(e.title.trim());
      body.title = draft ? `Draft: ${t}` : t;
    }
    if (e.description !== null) body.description = e.description;
    if (e.labels !== null) body.labels = e.labels.join(',');
    const sent = (key: string) => (Array.isArray(body[key]) ? (body[key] as number[]).length : 0);
    const counts = [sent('reviewer_ids'), sent('assignee_ids')];
    const v = ask(() => this.fake.put(p.path, n, body));
    const roles = [['reviewers', 'a reviewer', e.reviewers], ['assignees', 'an assignee', e.assignees]] as const;
    roles.forEach(([field, role, change], i) => {
      const dropped = j.notAdded(v, field, change?.add ?? []);
      if (dropped.length === 0) return;
      // GitLab Free kept only the first; a non-member is dropped the same way: one who is a member was dropped by the limit.
      const kept = j.keptOnly(v, field, counts[i]);
      if (kept !== null && isMember(() => this.fake.member(p.id, dropped[0]))) {
        throw { ...gbError('InvalidInput', `GitLab kept only ${kept.name}: this project allows one ${field === 'reviewers' ? 'reviewer' : 'assignee'}`), detail: { kind: 'peopleLimit', role: field } } satisfies GbError;
      }
      throw gbError('InvalidInput', `GitLab didn't add ${dropped.map((id) => `user ${id}`).join(', ')} as ${role}: are they a member of ${p.path}?`);
    });
    return this.mrFrom(p, v);
  }

  /** GitLab's draft is its title's prefix. */
  setDraft(p: ForgeProject, n: number, draft: boolean): ForgeMr {
    const current = ask(() => this.fake.getMr(p.path, n, { diverged: false, rebaseInProgress: false }));
    const title = j.stripDraft(typeof current.title === 'string' ? current.title : '');
    return this.mrFrom(p, ask(() => this.fake.put(p.path, n, { title: draft ? `Draft: ${title}` : title })));
  }

  /** Points the MR at `target`. */
  retarget(p: ForgeProject, n: number, target: string): ForgeMr {
    return this.mrFrom(p, ask(() => this.fake.put(p.path, n, { target_branch: target })));
  }
  // --- end merging ---

  // --- creating (gitlab.rs, 4C T3) ---
  /** `create_mr`: GitLab creates in the source project; a fork's MR names its target. `headSha`: the
   * source branch's tip, when the caller found it on the origin. */
  createMr(p: ForgeProject, req: CreateMr, headSha: string | null = null): CreateOutcome {
    const sourceId = req.source.project === p.path ? p.id : this.project(req.source.project).id;
    const body = j.createBody(req, sourceId, p.id);
    const v = ask(() => this.fake.createMr(req.source.project, body, headSha));
    return { mr: j.createdMr(v, req.source.project, p.path) ?? fail(unreadable('merge request')), failed: [] };
  }

  /** `search_users`: the project's members matching `query`, 20 of them. */
  searchUsers(p: ForgeProject, query: string): ForgeUser[] {
    return j.users(ask(() => this.fake.members(p.id, query.trim(), USERS_PER_PAGE)));
  }

  /** `labels`: the project's labels matching `query`, up to 50. */
  labels(p: ForgeProject, query: string): ForgeLabel[] {
    return ask(() => this.fake.labelsJson(p.id, query.trim())).slice(0, LABELS_PER_PAGE).flatMap((v) => j.label(v) ?? []);
  }

  /** `mr_templates`: the `.md` files directly in `.gitlab/merge_request_templates`, each read (one that
   * went away is skipped); none when there's no such directory. */
  mrTemplates(p: ForgeProject): MrTemplate[] {
    let entries: Json[];
    try {
      entries = this.fake.tree(p.id, GITLAB_TEMPLATE_DIR);
    } catch (e) {
      if (e instanceof FakeHttp && e.status === 404) return [];
      throw isGbError(e) ? e : e instanceof FakeHttp ? statusError(e.status, e.body) : e;
    }
    const paths = entries.filter((e) => e.type === 'blob').flatMap((e) => (typeof e.path === 'string' ? [e.path] : [])).filter(isTemplatePath).slice(0, MAX_TEMPLATES);
    const out: MrTemplate[] = [];
    for (const path of paths) {
      try {
        out.push({ name: templateName(path), body: clipTemplate(this.fake.raw(p.id, path)), path });
      } catch (e) {
        if (e instanceof FakeHttp && e.status === 404) continue;
        throw e;
      }
    }
    return sortTemplates(out);
  }

  /** The trait's default for a provider that can't add the parts afterwards (GitLab creates them all at once). */
  completeCreate(): never {
    throw gbError('InvalidInput', "Adding reviewers, assignees and labels afterwards isn't supported by this forge yet");
  }
}

/** gitlab.rs `USERS_PER_PAGE`, `LABELS_PER_PAGE`. */
const USERS_PER_PAGE = 20;
const LABELS_PER_PAGE = 50;

// create.rs: GitLab's template rules.
export const GITLAB_TEMPLATE_DIR = '.gitlab/merge_request_templates';
const MAX_TEMPLATES = 20;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const DEFAULT_TEMPLATE = 'Default';
/** `strip_md`: the file name without a (case-insensitive) `.md`; null when it has none or nothing before it. */
const stripMd = (file: string): string | null => (file.length > 3 && file.slice(-3).toLowerCase() === '.md' ? file.slice(0, -3) : null);
const splitPath = (path: string): [string, string] => (path.includes('/') ? [path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1)] : ['', path]);
/** `is_template_path` for GitLab. */
export const isTemplatePath = (path: string): boolean => {
  const [dir, file] = splitPath(path);
  return stripMd(file) !== null && dir === GITLAB_TEMPLATE_DIR;
};
/** `template_name`. */
export const templateName = (path: string): string => stripMd(splitPath(path)[1]) ?? splitPath(path)[1];
/** `clip_template`: at most `MAX_TEMPLATE_BYTES`, `\r\n` as `\n`. */
export const clipTemplate = (text: string): string => lossyUtf8(utf8Bytes(text).slice(0, MAX_TEMPLATE_BYTES)).replaceAll('\r\n', '\n');
/** `sort_templates`: `Default` first, then by name (case-insensitive), at most `MAX_TEMPLATES`. */
export function sortTemplates(list: MrTemplate[]): MrTemplate[] {
  const key = (t: MrTemplate): [number, string] => [t.name.toLowerCase() === DEFAULT_TEMPLATE.toLowerCase() ? 0 : 1, t.name.toLowerCase()];
  return list.map((t) => ({ t, k: key(t) })).sort((a, b) => a.k[0] - b.k[0] || compareBytes(a.k[1], b.k[1])).map((x) => x.t).slice(0, MAX_TEMPLATES);
}

/** time.rs `BRANCH_UPDATE_POLLS_MS`' length: how many times `update_branch` looks (the demo doesn't wait between). */
const BRANCH_UPDATE_POLLS = 10;

/** The member lookup answered (`is_ok`). */
function isMember(f: () => Json): boolean {
  try {
    ask(f);
    return true;
  } catch {
    return false;
  }
}

/** gitlab.rs `merge_body`: the options (the messages are GitLab's own) and, for `auto`, both
 * auto-merge flags (17.11's `auto_merge` and the older `merge_when_pipeline_succeeds`). */
export function mergeBody(o: MergeOptions, auto: boolean): Json {
  const b: Json = {};
  if (o.squash !== null) b.squash = o.squash;
  if (o.deleteSourceBranch !== null) b.should_remove_source_branch = o.deleteSourceBranch;
  if (o.expectedSha !== null) b.sha = o.expectedSha;
  if (auto) {
    b.auto_merge = true;
    b.merge_when_pipeline_succeeds = true;
  }
  return b;
}

/** gitlab.rs `merge_refused`: another head (409), or it can't merge now (405/406). */
export function mergeRefused(n: number, e: GbError): GbError {
  if (e.message.includes('SHA does not match')) return gbError('InvalidInput', `!${n} changed since it was loaded: refresh and try again`);
  if (e.message.includes('HTTP 405') || e.message.includes('HTTP 406')) return gbError('InvalidInput', `GitLab can't merge !${n} now: refresh to see why`);
  return e;
}

/** gitlab.rs `auto_merge_refused`. */
export function autoMergeRefused(n: number, e: GbError): GbError {
  if (e.message.includes('HTTP 405') || e.message.includes('HTTP 406')) return gbError('InvalidInput', `GitLab can't set !${n} to auto-merge now: refresh to see why`);
  return mergeRefused(n, e);
}

/** gitlab.rs `cancel_refused`: it isn't set (any more). */
export function cancelRefused(n: number, e: GbError): GbError {
  if (e.message.includes('HTTP 405') || e.message.includes('HTTP 406')) return gbError('InvalidInput', `!${n} isn't set to auto-merge any more: refresh`);
  return e;
}

/** gitlab.rs `rebase_refused`: a 403 is about the branch, never the token; a 409 couldn't queue it. */
export function rebaseRefused(n: number, e: GbError): GbError {
  if (e.kind === 'AuthFailed' && e.message.includes(REFUSED)) {
    let said = e.message.slice(e.message.indexOf(REFUSED) + REFUSED.length);
    while (said.startsWith('403 Forbidden')) said = said.slice('403 Forbidden'.length);
    said = said.replace(/^[ -]+/, '');
    return gbError('InvalidInput', `GitLab can't rebase !${n}: ${said === '' ? "the token's user can't push to its source branch" : said}`);
  }
  if (e.message.includes('HTTP 409') || (e.kind === 'InvalidInput' && e.message.includes('enqueue'))) return gbError('InvalidInput', `GitLab couldn't start rebasing !${n}: try again in a moment`);
  return e;
}

/** gitlab.rs `rebase_failed`: GitLab's `merge_error` once it's no longer in progress, while the
 * head is still the one it started from (`expectedSha`, when known). */
export function rebaseFailed(n: number, v: Json, expectedSha: string | null): GbError | null {
  if (v.rebase_in_progress === true) return null;
  const said = typeof v.merge_error === 'string' ? v.merge_error.trim() : '';
  if (said === '') return null;
  if (expectedSha !== null && v.sha !== expectedSha) return null;
  return gbError('InvalidInput', `GitLab couldn't rebase !${n}: ${[...redact(said)].slice(0, 200).join('')}`);
}

function fail(e: GbError): never {
  throw e;
}
