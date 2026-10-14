import { describe, expect, it } from 'vitest';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { MrEdit } from '../../api/gen/MrEdit';
import { FakeGitLab, type Json } from './fakeGitlab';
import * as j from './gitlabJson';
import { forgeLabFile } from './testkit';

const author = { id: 7, username: 'ada', name: 'Ada' };
const mrJson = (extra: Json = {}): Json => ({ iid: 12, title: 'Dev work', state: 'opened', author, source_branch: 'dev', target_branch: 'main', web_url: 'https://gitlab.example.com/g/p/-/merge_requests/12', ...extra });
const P = 'group/project';

// Ports of the tests in crates/gitvolt-forge/src/gitlab.rs (the `json` module's).
describe('gitlab::json', () => {
  it('normalizes a user preferring the public email', () => {
    expect(j.user({ id: 7, username: 'ada', name: '', avatar_url: 'https://g/a.png', web_url: 'https://g/ada', public_email: '', email: 'ada@corp.example' })).toEqual({
      id: 7, username: 'ada', name: 'ada', avatarUrl: 'https://g/a.png', webUrl: 'https://g/ada', email: 'ada@corp.example',
    });
    expect(j.user({ id: 7 })).toBeNull();
  });

  it('normalizes a fork and its settings', () => {
    const v = {
      id: 77, name: 'project', path_with_namespace: 'alice/project', namespace: { full_path: 'alice', kind: 'user', avatar_url: 'https://g/uploads/-/system/user/avatar/7/a.png' }, web_url: 'https://g/alice/project',
      default_branch: 'main', http_url_to_repo: 'https://g/alice/project.git', ssh_url_to_repo: 'git@g:alice/project.git', forked_from_project: { path_with_namespace: 'group/project' },
      last_activity_at: '2026-10-04T12:00:00.000Z', archived: false, merge_method: 'rebase_merge', squash_option: 'always', remove_source_branch_after_merge: true,
    };
    const p = j.project('g', v)!;
    expect([p.kind, p.id, p.owner, p.forkOf, p.updatedAt]).toEqual(['gitlab', 77, 'alice', 'group/project', 1_791_115_200]);
    expect(p.ownerAvatarUrl).toBe('https://g/uploads/-/system/user/avatar/7/a.png');
    expect(j.project('g', { id: 1, path_with_namespace: 'group/project', namespace: { full_path: 'group', kind: 'group', avatar_url: 'https://g/uploads/g.png' } })!.ownerAvatarUrl).toBe('https://g/uploads/g.png');
    expect(j.project('g', { id: 1, path_with_namespace: 'solo' })!.owner).toBe('');
    expect(j.settings(v)).toEqual({ mergeMethods: ['semiLinear'], squash: 'always', deleteSourceBranch: true });
    expect(j.settings({})).toEqual({ mergeMethods: ['merge'], squash: 'defaultOff', deleteSourceBranch: false });
  });

  it('the api scope is what writes', () => {
    expect(j.tokenWrite({ scopes: ['api', 'read_user'] })).toEqual({ kind: 'yes' });
    expect(j.tokenWrite({ scopes: ['read_api'] })).toEqual({ kind: 'no', missing: 'api' });
  });

  it('strips the draft prefix and maps states', () => {
    expect(j.stripDraft('Draft: Explore')).toBe('Explore');
    expect(j.stripDraft('[Draft] Explore')).toBe('Explore');
    expect(j.stripDraft('WIP: Explore')).toBe('Explore');
    expect(j.stripDraft('  Draft: x')).toBe('x');
    expect(j.stripDraft('Drafting the plan')).toBe('Drafting the plan');
    expect(j.mrState('opened', true)).toBe('draft');
    expect(j.mrState('locked', false)).toBe('merging');
    expect(j.mergeStatus({ state: 'locked' })).toEqual({ kind: 'blocked', reason: "It's being merged" });
    expect(j.mrState('weird', false)).toBeNull();
    const m = j.mr({ iid: 5, title: 'Draft: Explore', draft: true, state: 'opened', author, source_branch: 'x', target_branch: 'main', sha: 'abc', labels: ['a'], updated_at: '2026-10-04T12:00:00Z', has_conflicts: true }, P, P)!;
    expect([m.title, m.state, m.conflicts, m.updatedAt, m.labels]).toEqual(['Explore', 'draft', true, 1_791_115_200, ['a']]);
  });

  it("an MR whose description has GitVolt's stack table is stacked", () => {
    const v = (description: unknown) => mrJson({ iid: 5, title: 't', description });
    expect(j.mr(v('Intro\n\n<!-- gitvolt-stack:start -->\n| table |\n<!-- gitvolt-stack:end -->'), P, P)!.stacked).toBe(true);
    expect(j.mr(v('Plain text'), P, P)!.stacked).toBe(false);
    expect(j.mr(v(null), P, P)!.stacked).toBe(false);
    expect(j.mr(v('<!-- gitvolt-stack:start --> quoted, never closed'), P, P)!.stacked).toBe(false);
    expect(j.createdMr(v('<!-- gitvolt-stack:start -->\nT\n<!-- gitvolt-stack:end -->'), P, P)!.stacked).toBe(true);
  });

  it('pipelines, merge statuses and approvals', () => {
    expect(j.pipelineStatus('waiting_for_resource')).toBe('pending');
    expect(j.pipelineStatus('canceling')).toBe('canceled');
    const by = j.pipelinesBySha([{ sha: 'a', status: 'failed' }, { sha: 'a', status: 'success' }, { sha: 'b', status: 'manual', web_url: 'u' }]);
    expect(by.get('a')!.status).toBe('failed'); // the newest of a commit's pipelines
    expect(by.get('b')!.webUrl).toBe('u');
    const status = (s: string) => j.mergeStatus({ state: 'opened', detailed_merge_status: s });
    expect(status('mergeable')).toEqual({ kind: 'mergeable' });
    expect(status('checking')).toEqual({ kind: 'checking' });
    expect(status('ci_must_pass')).toEqual({ kind: 'blocked', reason: 'The pipeline must succeed first' });
    expect(status('something_new')).toEqual({ kind: 'blocked', reason: 'GitLab says: something new' });
    // Every documented status has its own reason: none falls through to GitLab's own words.
    for (const s of j.DETAILED_MERGE_STATUSES) expect(JSON.stringify(status(s))).not.toContain('GitLab says');
    expect(j.mergeStatus({ state: 'merged' })).toEqual({ kind: 'blocked', reason: "It's merged already" });
    expect(j.mergeStatus({ state: 'opened', merge_status: 'cannot_be_merged' })).toEqual({ kind: 'blocked', reason: 'It has conflicts: rebase or merge the target branch first' });
    const grace = { user: { id: 8, username: 'grace', name: 'Grace' } };
    const r = j.review({ detailed_merge_status: 'not_approved' }, { approved_by: [grace], approvals_required: 2 });
    expect([r.decision, r.approvals, r.approvalsRequired]).toEqual(['reviewRequired', 1, 2]);
    expect(j.review({}, { approved_by: [grace], approvals_required: 0 }).decision).toBe('approved');
    expect(j.review({ detailed_merge_status: 'requested_changes' }, null).decision).toBe('changesRequested');
    expect(j.review({ reviewers: [{ id: 1 }] }, { approvals_required: 1, approved_by: [] })).toEqual({ decision: 'reviewRequired', approvals: 0, approvalsRequired: 1, reviews: [] });
  });

  it('a snippet ends at the commented line', () => {
    const diff = '@@ -1,4 +1,5 @@\n one\n-two\n+zwei\n+drei\n three\n';
    expect(j.snippet(diff, 3, null)).toBe('-two\n+zwei\n+drei');
    expect(j.snippet(diff, null, 2)).toBe(' one\n-two');
    expect(j.snippet(diff, 4, null)).toBe('+zwei\n+drei\n three');
    expect(j.snippet(diff, 40, null)).toBeNull();
    expect(j.snippet('@@ -10,2 +12,2 @@\n a\n+b\n', 13, null)).toBe(' a\n+b');
  });

  it("a range's snippet is its lines and at least three", () => {
    const diff = '@@ -1,6 +1,7 @@\n one\n-two\n+zwei\n+drei\n three\n four\n five\n six\n';
    expect(j.rangeSnippet(diff, [6, null], [1, 1])).toBe(' one\n-two\n+zwei\n+drei\n three\n four\n five');
    expect(j.rangeSnippet(diff, [3, null], [null, 2])).toBe('-two\n+zwei\n+drei');
    expect(j.rangeSnippet(diff, [5, 4], [4, 3])).toBe('+drei\n three\n four');
    expect(j.rangeSnippet(diff, [6, null], [40, null])).toBe(' three\n four\n five');
  });

  it("a multi-line note's position has its range", () => {
    const end = { line_code: 'abc_5_6', type: null, old_line: 5, new_line: 6 };
    const pos = (range: unknown) => j.note({ id: 1, author: { id: 8, username: 'grace' }, body: 'b', position: { new_path: 'a.txt', old_path: 'a.txt', new_line: 6, old_line: 5, line_range: range } })!.position!;
    let p = pos({ start: { line_code: 'abc_1_1', type: null, old_line: 1, new_line: 1 }, end });
    expect([p.line, p.oldLine, p.startLine, p.startOldLine]).toEqual([6, 5, 1, 1]);
    p = pos({ start: { line_code: 'abc_2_2', type: 'old', old_line: 2, new_line: null }, end });
    expect([p.startLine, p.startOldLine]).toEqual([null, 2]);
    p = pos({ start: end, end }); // one line: a range that starts where it ends
    expect([p.startLine, p.startOldLine]).toEqual([null, null]);
    p = pos(null);
    expect([p.line, p.startLine, p.startOldLine]).toEqual([6, null, null]);
  });

  it("a branch's MR is its open one, else the newest", () => {
    const v = (iid: number, state: string, at: string) => j.mr(mrJson({ iid, title: 't', state, author: { id: 1, username: 'a' }, updated_at: at }), 'p', 'p')!;
    expect(j.pickForBranch([v(1, 'merged', '2026-10-04T00:00:00Z'), v(2, 'opened', '2026-01-01T00:00:00Z')])!.number).toBe(2);
    expect(j.pickForBranch([v(1, 'merged', '2026-10-04T00:00:00Z'), v(3, 'closed', '2026-10-05T00:00:00Z')])!.number).toBe(3);
    expect(j.pickForBranch([])).toBeNull();
  });

  it('a draft is a title prefix, never doubled', () => {
    expect(j.draftTitle('Add login', true)).toBe('Draft: Add login');
    expect(j.draftTitle(' [Draft] Add login ', true)).toBe('[Draft] Add login');
    expect(j.draftTitle('Draft: x', false)).toBe('Draft: x');
    expect(j.draftTitle('Add login ', false)).toBe('Add login');
  });

  it('the create body names the target only for a fork and squash only when set', () => {
    const req = { source: { project: 'alice/project', branch: 'feature' }, targetBranch: 'main', title: 'Add login', description: 'Why.', draft: false, reviewers: [8], assignees: [7], labels: ['bug', 'ui'], squash: null, deleteSourceBranch: true };
    expect(j.createBody(req, 77, 42)).toEqual({ source_branch: 'feature', target_branch: 'main', title: 'Add login', description: 'Why.', assignee_ids: [7], reviewer_ids: [8], labels: ['bug', 'ui'], target_project_id: 42, remove_source_branch: true });
    expect(j.createBody(req, 42, 42)).not.toHaveProperty('target_project_id');
    expect(j.createBody({ ...req, squash: false }, 42, 42).squash).toBe(false);
  });

  it('a created MR normalizes with the paths it was made with', () => {
    const v = mrJson({ iid: 3, title: 'Draft: Add login', draft: true, sha: 'abc', web_url: 'https://g/group/project/-/merge_requests/3', labels: ['bug'], has_conflicts: false, updated_at: '2026-10-04T12:00:00Z' });
    const m = j.createdMr(v, 'alice/project', P)!;
    expect([m.number, m.state, m.sourceProject, m.targetProject]).toEqual([3, 'draft', 'alice/project', P]);
    expect([m.labels, m.conflicts, m.updatedAt, m.headSha, m.review.decision]).toEqual([['bug'], false, 1_791_115_200, 'abc', 'none']);
    expect(j.label({ name: 'bug', color: '#d9534f', description: '' })).toEqual({ name: 'bug', color: '#d9534f', description: null });
  });

  it('a people change is sent as the whole lists', () => {
    const current = { reviewers: [{ id: 7, username: 'ada' }], assignees: [{ id: 8, username: 'grace' }] };
    const edit: MrEdit = { title: null, description: null, labels: null, reviewers: { add: [8], remove: [7] } };
    expect(j.peopleBody(current, edit)).toEqual({ reviewer_ids: [8] }); // assignees untouched: not sent
    expect(j.peopleBody(current, { ...edit, reviewers: { add: [], remove: [] }, assignees: { add: [], remove: [8] } })).toEqual({ assignee_ids: [] });
  });

  it('the people GitLab dropped are found', () => {
    const answer = { reviewers: [{ id: 8, username: 'grace' }] };
    expect(j.notAdded(answer, 'reviewers', [8, 99])).toEqual([99]);
    expect(j.notAdded(answer, 'assignees', [])).toEqual([]);
  });

  it('an open MR set to auto-merge says by whom', () => {
    const v = (state: string, extra: Json) => j.mr(mrJson({ iid: 5, title: 't', state, ...extra }), P, P)!.autoMerge;
    const by = v('opened', { merge_when_pipeline_succeeds: true, merge_user: { id: 8, username: 'grace', name: 'Grace Hopper' } })!;
    expect([by.enabledBy?.name, by.method]).toEqual(['Grace Hopper', null]);
    expect(v('opened', { auto_merge_enabled: true })?.enabledBy).toBeNull(); // the newer field, no merge_user
    expect(v('opened', { merge_when_pipeline_succeeds: false })).toBeNull();
    expect(v('merged', { merge_when_pipeline_succeeds: true })).toBeNull(); // a merged MR keeps the flag: not shown
  });

  it('the people flags read as limits', () => {
    const flags = (r: boolean, a: boolean) => ({ data: { project: { mergeRequests: { nodes: [{ allowsMultipleReviewers: r, allowsMultipleAssignees: a }] } } } });
    expect(j.peopleLimits(flags(false, false))).toEqual({ maxReviewers: 1, maxAssignees: 1 });
    expect(j.peopleLimits(flags(true, false))).toEqual({ maxReviewers: null, maxAssignees: 1 });
    expect(j.peopleLimits({ data: { project: { mergeRequests: { nodes: [] } } } })).toEqual({ maxReviewers: null, maxAssignees: null });
    expect(j.peopleLimits({ errors: [{ message: "Field 'allowsMultipleReviewers' doesn't exist on type 'MergeRequest'" }] })).toEqual({ maxReviewers: null, maxAssignees: null });
  });

  it('kept_only one of several names who', () => {
    const one = { reviewers: [{ id: 7, username: 'ada', name: 'Ada Lovelace' }] };
    expect(j.keptOnly(one, 'reviewers', 2)?.name).toBe('Ada Lovelace');
    expect(j.keptOnly(one, 'reviewers', 1)).toBeNull();
    expect(j.keptOnly({ reviewers: [] }, 'reviewers', 2)).toBeNull();
  });

  it('a mutation went in without errors', () => {
    const name = 'mergeRequestRequestChanges';
    expect(j.mutationOk({ data: { [name]: { errors: [] } } }, name)).toBe(true);
    expect(j.mutationOk({ data: { [name]: { errors: ['Not a reviewer'] } } }, name)).toBe(false);
    expect(j.mutationOk({ errors: [{ message: "Field 'x' doesn't exist on type 'Mutation'" }] }, name)).toBe(false);
  });

  it('the detail reads the base and the subscription', () => {
    const d = j.detail(mrJson({ diff_refs: { base_sha: 'abc', head_sha: 'def', start_sha: 'abc' }, subscribed: true }), P, P, null)!;
    expect([d.baseSha, d.subscribed]).toEqual(['abc', true]);
    const bare = j.detail(mrJson(), P, P, null)!;
    expect(bare).not.toHaveProperty('baseSha');
    expect(bare).not.toHaveProperty('subscribed');
    expect(bare).not.toHaveProperty('mergedSha');
  });

  it('a merged MR landed as its merge commit, else its squash commit', () => {
    const landed = (state: string, merge: unknown, squash: unknown) => j.detail(mrJson({ title: 't', state, merge_commit_sha: merge, squash_commit_sha: squash }), P, P, null)!.mergedSha;
    expect(landed('merged', 'm1', 's1')).toBe('m1');
    expect(landed('merged', null, 's1')).toBe('s1');
    expect(landed('merged', null, null)).toBeUndefined();
    expect(landed('opened', 'm1', null)).toBeUndefined();
  });

  it('note awards come by note with mine and who', () => {
    const answer = {
      data: { project: { mergeRequest: { notes: {
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
        nodes: [
          { id: 'gid://gitlab/Note/101', awardEmoji: { nodes: [
            { name: 'thumbsup', user: { id: 'gid://gitlab/User/7', username: 'ada', name: 'Ada' } },
            { name: 'thumbsup', user: { id: 'gid://gitlab/User/8', username: 'grace', name: '' } },
            { name: 'tada', user: { id: 'gid://gitlab/User/8', username: 'grace', name: '' } },
          ] } },
          { id: 'gid://gitlab/Note/102', awardEmoji: { nodes: [] } },
        ],
      } } } },
    };
    const out = j.noteAwards(answer, 7)!;
    expect(out.next).toBe('c1');
    expect(out.notes).toEqual([['101', [{ name: 'thumbsup', count: 2, mine: true, users: ['Ada', 'grace'] }, { name: 'tada', count: 1, mine: false, users: ['grace'] }]]]);
    expect(j.noteAwards({ errors: [{ message: "Field 'awardEmoji' doesn't exist on type 'Note'" }] }, 7)).toBeNull();
    const list = [{ name: 'thumbsup', user: { id: 1, username: 'ada', name: 'Ada' } }, { name: 'thumbsup', user: { id: 2, username: 'grace', name: '' } }];
    expect(j.awards(list, 2)).toEqual([{ name: 'thumbsup', count: 2, mine: true, users: ['Ada', 'grace'] }]);
  });

  it("a thread's own system note stays in the thread, in order", () => {
    const who = { id: 8, username: 'grace', name: 'Grace' };
    const d = j.discussion({ id: 'd2', individual_note: false, notes: [
      { id: 1, body: 'Why?', author: who, created_at: '2026-10-04T09:00:00Z', system: false, resolvable: true, resolved: false },
      { id: 2, body: 'changed this line in version 2 of the diff', author: who, created_at: '2026-10-04T19:00:00Z', system: true, resolvable: false },
      { id: 3, body: 'Fixed.', author: who, created_at: '2026-10-04T19:05:00Z', system: false, resolvable: true, resolved: false },
    ] })!;
    expect(d.notes.map((n) => [n.id, n.system])).toEqual([['1', false], ['2', true], ['3', false]]);
    expect([d.resolvable, d.resolved]).toEqual([true, false]);
    expect(d).not.toHaveProperty('resolvedBy');
  });

  it('fill_snippets gives a diff note its lines from the MR diffs', () => {
    const d = j.discussion({ id: 'd', notes: [{ id: 1, author, body: 'b', position: { new_path: 'a.txt', old_path: 'a.txt', new_line: 3, old_line: null } }] })!;
    j.fillSnippets([d], [{ old_path: 'a.txt', new_path: 'a.txt', diff: '@@ -1,4 +1,5 @@\n one\n-two\n+zwei\n+drei\n three\n' }]);
    expect(d.notes[0].position!.snippet).toBe('-two\n+zwei\n+drei');
  });

  it('a position names each line\'s sides and a range with its line codes', async () => {
    const refs = { baseSha: 'b', startSha: 's', headSha: 'h' };
    const c = (start: { kind: 'context' | 'added' | 'removed'; oldLine: number; newLine: number } | null, end: { kind: 'context' | 'added' | 'removed'; oldLine: number; newLine: number }) => ({ anchor: { path: 'README.md', oldPath: 'README.md', start, end }, body: 'Both?', refs });
    expect(await j.positionJson(c({ kind: 'context', oldLine: 1, newLine: 1 }, { kind: 'added', oldLine: 2, newLine: 2 }))).toEqual({
      position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h', old_path: 'README.md', new_path: 'README.md', new_line: 2,
      line_range: {
        start: { line_code: '8ec9a00bfd09b3190ac6b22251dbb1aa95a0579d_1_1', type: 'old', old_line: 1, new_line: 1 },
        end: { line_code: '8ec9a00bfd09b3190ac6b22251dbb1aa95a0579d_2_2', type: 'new', new_line: 2 },
      },
    });
    const removed = await j.positionJson(c(null, { kind: 'removed', oldLine: 3, newLine: 2 }));
    expect([removed.old_line, removed.new_line, removed.line_range]).toEqual([3, undefined, undefined]);
    const unchanged = await j.positionJson(c(null, { kind: 'context', oldLine: 4, newLine: 5 }));
    expect([unchanged.old_line, unchanged.new_line]).toEqual([4, 5]); // an unchanged line names both
  });

  it("the diff refs, files and drafts read from GitLab's answers", () => {
    expect(j.diffRefs({ diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } })).toEqual({ baseSha: 'b', startSha: 's', headSha: 'h' });
    expect(j.diffRefs({ diff_refs: null })).toBeNull();
    const files = j.reviewFiles([
      { old_path: 'old.md', new_path: 'README.md', diff: '@@ -1 +1,2 @@\n Readme\n+Second line\n' },
      { old_path: 'big.bin', new_path: 'big.bin', diff: '', too_large: true },
    ]);
    expect([files[0].path, files[0].oldPath, files[0].lines.length, files[0].tooLarge]).toEqual(['README.md', 'old.md', 2, false]);
    expect([files[1].lines.length, files[1].tooLarge]).toEqual([0, true]);
    const d = j.draft({ id: 5, note: 'Both?', discussion_id: null, position: { new_path: 'README.md', old_path: 'README.md', new_line: 2, old_line: null, head_sha: 'h', line_range: null } })!;
    expect([d.id, d.body, d.position!.line, d.position!.headSha]).toEqual(['5', 'Both?', 2, 'h']);
    expect(j.draft({ id: 6, note: 'General', position: null })!.position).toBeNull();
    const none = { id: 7, note: 'General', position: { position_type: 'text', base_sha: null, start_sha: null, head_sha: null, old_path: null, new_path: null, old_line: null, new_line: null, line_range: null } };
    expect(j.draft(none)!.position).toBeNull(); // GitLab's all-null position is no position
  });

  it('a rebase is offered while open and pushable, with GitLab\'s behind', () => {
    const rebase = ['rebase', 'rebaseSkipCi'];
    const offer = (extra: Json, me: number | null) => j.updateOffer(mrJson({ author: { id: 8, username: 'grace' }, target_project_id: 1, ...extra }), me);
    expect(offer({ diverged_commits_count: 3 }, null)).toEqual({ behind: 3, forgeBehind: true, kinds: rebase, inProgress: false });
    expect([offer({ detailed_merge_status: 'need_rebase' }, null)?.behind, offer({ detailed_merge_status: 'need_rebase' }, null)?.forgeBehind]).toEqual([null, true]);
    expect(offer({ diverged_commits_count: 3, rebase_in_progress: true }, null)?.inProgress).toBe(true);
    expect(offer({ diverged_commits_count: 0 }, null)).toEqual({ behind: null, forgeBehind: false, kinds: rebase, inProgress: false });
    expect(offer({ diverged_commits_count: 3, state: 'merged' }, null)).toBeNull();
    // A fork's branch: its author pushes to it, others only when it allows collaboration.
    const fork = (extra: Json = {}) => ({ diverged_commits_count: 2, source_project_id: 5, ...extra });
    expect(offer(fork(), 7)).toBeNull();
    expect(offer(fork(), 8)).not.toBeNull(); // the author's own fork
    expect(offer(fork({ allow_collaboration: true }), 7)).not.toBeNull();
    expect(offer(fork(), null)).not.toBeNull(); // who the user is isn't known: GitLab's 403 says
  });

  it('labels come as names or with colours', () => {
    expect(j.labelsOf(['a', { name: 'b', color: '#ABC' }])).toEqual({ names: ['a', 'b'], colors: { b: '#aabbcc' } });
    expect(j.labelColor('ededed')).toBe('#ededed');
    expect(j.labelColor('#12')).toBeNull();
    expect(j.labelColor('zzzzzz')).toBeNull();
  });

  it('parses RFC 3339 as the core does', () => {
    expect(j.parseRfc3339('2026-10-04T12:00:00Z')).toBe(1_791_115_200);
    expect(j.parseRfc3339('2026-10-04T14:00:00.250+02:00')).toBe(1_791_115_200);
    expect(j.parseRfc3339('2026-10-04')).toBeNull();
    expect(j.parseRfc3339('2026-13-04T12:00:00Z')).toBeNull();
  });
});

// The fake GitLab's JSON through this mapping: what the core makes of the forge_lab project's MRs.
describe('the fake GitLab through the mapping', () => {
  const f = new FakeGitLab([forgeLabFile()], () => '2026-10-10T18:00:00Z');
  const proj = 'orbital/forge-lab';

  it('a listed MR is an MR with the state, labels and branches the seed says', () => {
    const mrs = f.listMrs(proj, { state: 'all' }).map((m) => j.mr(m, proj, proj)).filter((m): m is ForgeMr => m !== null);
    expect(mrs.length).toBe(f.listMrs(proj, { state: 'all' }).length);
    const hud = mrs.find((m) => m.number === 1)!;
    expect(hud).toMatchObject({ title: 'Scale the HUD with the window', state: 'open', sourceBranch: 'feature/hud-scale', targetBranch: 'main', labels: ['hud'], labelColors: { hud: '#428bca' }, author: { username: 'ada', name: 'Ada Lovelace' }, stacked: false, autoMerge: null });
    const draft = mrs.find((m) => m.number === 2)!;
    expect([draft.title, draft.state]).toEqual(['Add a radar panel', 'draft']);
    expect(mrs.find((m) => m.number === 3)!.state).toBe('merged');
    expect(j.pickForBranch(mrs.filter((m) => m.sourceBranch === 'fix/dock-chime'))!.number).toBe(3);
  });

  it('a single MR with its approvals is a detail with its review and merge status', () => {
    const m = f.mr(proj, 1);
    const d = j.detail(f.getMr(proj, 1, { diverged: true, rebaseInProgress: false }), proj, proj, f.approvalsJson(m))!;
    expect(d.mr.pipeline).toMatchObject({ status: 'success' });
    expect(d.mr.review).toMatchObject({ decision: 'reviewRequired', approvals: 0, approvalsRequired: 1 });
    expect(d.mergeStatus).toEqual({ kind: 'blocked', reason: 'It needs approval first' });
    expect(d.reviewers.map((u) => u.username)).toEqual(['you', 'grace']);
    expect(d.baseSha).toBe('b'.repeat(40));
    expect(d.subscribed).toBe(true);
    expect(d.description).toContain('scales in whole steps');
    const merged = j.detail(f.getMr(proj, 3, { diverged: false, rebaseInProgress: false }), proj, proj, null)!;
    expect([merged.mr.state, merged.mergedSha, merged.mergeStatus]).toEqual(['merged', 'm'.repeat(40), { kind: 'blocked', reason: "It's merged already" }]);
  });

  it("an approved MR's decision is approved; a pipeline list maps to each head", () => {
    const four = j.detail(f.getMr(proj, 4, { diverged: false, rebaseInProgress: false }), proj, proj, f.approvalsJson(f.mr(proj, 4)))!;
    expect([four.mr.review.decision, four.mr.review.reviews.map((r) => r.user.username)]).toEqual(['approved', ['grace']]);
    expect(j.pipelinesBySha(f.pipelinesJson(proj)).get('1'.repeat(40))?.status).toBe('success');
  });

  it('the threads become discussions with their position, resolution and snippet', () => {
    const m = f.mr(proj, 1);
    const ds = m.discussions.map((d) => j.discussion(f.discussionJson(d))!);
    expect(ds.map((d) => [d.id, d.notes.length, d.resolvable, d.resolved])).toEqual([['d1', 1, false, false], ['d2', 1, true, false], ['d3', 2, true, true], ['d4', 1, false, false]]);
    expect([ds[2].resolvedBy, ds[2].resolvedAt]).toEqual(['Grace Hopper', j.parseRfc3339('2026-10-10T15:00:00Z')]);
    expect(ds[3].notes[0].system).toBe(true);
    j.fillSnippets(ds, f.diffsJson(m));
    expect(ds[1].notes[0].position).toMatchObject({ path: 'src/hud.rs', line: 8, oldLine: null, headSha: '1'.repeat(40) });
    expect(ds[1].notes[0].position!.snippet).toBe('+\n+/// The HUD\'s scale for a window `height` pixels tall.\n+pub fn hud_scale(height: u32) -> u32 {');
    expect(ds[0].notes[0].position).toBeNull();
  });

  it("the MR's diffs are review files whose lines take comments", () => {
    const files = j.reviewFiles(f.diffsJson(f.mr(proj, 1)));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'src/hud.rs', oldPath: 'src/hud.rs', tooLarge: false });
    expect(files[0].lines.map((l) => l.kind)).toEqual(['context', 'context', 'context', 'added', 'added', 'added', 'added', 'added']);
    expect(files[0].lines[3]).toEqual({ kind: 'added', oldLine: 6, newLine: 6 });
  });

  it('the project and its people limits read as the core does', () => {
    const p = j.project('gitlab.example.com', f.projectJson(f.project(proj)))!;
    expect([p.path, p.owner, p.name, p.defaultBranch, p.id]).toEqual([proj, 'orbital', 'forge-lab', 'main', 4242]);
    expect(j.peopleLimits(f.peopleFlags(proj))).toEqual({ maxReviewers: null, maxAssignees: null });
  });
});
