import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readBundle } from '../engine/bundle';
import { FakeGitLab, FakeHttp, WEB } from './fakeGitlab';
import { parseForgeFile } from './seed';
import { forgeLabFile } from './testkit';

const fake = () => new FakeGitLab([forgeLabFile()], () => '2026-10-04T12:30:00Z');

describe('the fake GitLab', () => {
  it('answers an MR as GitLab does, with its head pipeline and diff refs when single', () => {
    const f = fake();
    const m = f.mr('orbital/forge-lab', 1);
    const list = f.mrJson(m, false);
    expect(list).toMatchObject({ id: 10_001, iid: 1, project_id: 4242, state: 'opened', draft: false, source_project_id: 4242, detailed_merge_status: 'not_approved', web_url: `${WEB}/orbital/forge-lab/-/merge_requests/1`, merge_when_pipeline_succeeds: false });
    expect(list).not.toHaveProperty('head_pipeline');
    const single = f.getMr('orbital/forge-lab', 1, { diverged: true, rebaseInProgress: true });
    expect(single).toMatchObject({ head_pipeline: { id: 50_001, status: 'success', web_url: `${WEB}/orbital/forge-lab/-/pipelines/50001` }, diff_refs: { base_sha: 'b'.repeat(40) }, subscribed: true });
    expect((single.author as { web_url: string }).web_url).toBe(`${WEB}/ada`);
  });

  it('lists by state, scope and reviewer, newest updated first', () => {
    const f = fake();
    expect(f.listMrs('orbital/forge-lab', { state: 'opened' }).map((m) => m.iid)).toEqual([6, 5, 4, 2, 1]);
    expect(f.listMrs('orbital/forge-lab', { state: 'opened', reviewerId: 100 }).map((m) => m.iid)).toEqual([1]);
    expect(f.listMrs('orbital/forge-lab', { sourceBranch: 'fix/dock-chime' }).map((m) => m.state)).toEqual(['merged']);
  });

  it('answers threads, approvals and a resolved discussion as GitLab does', () => {
    const f = fake();
    const m = f.mr('orbital/forge-lab', 1);
    expect(f.discussionJson(m.discussions[2])).toMatchObject({ id: 'd3', individual_note: false, notes: [{ resolvable: true, resolved: true, resolved_by: { username: 'grace' }, resolved_at: '2026-10-10T15:00:00Z' }, {}] });
    expect(f.noteJson(m.discussions[1].notes[0], true, false)).toMatchObject({ type: 'DiffNote', position: { new_path: 'src/hud.rs', new_line: 8, old_line: null, line_range: null } });
    expect(f.approvalsJson(f.mr('orbital/forge-lab', 4))).toEqual({ approved: true, approvals_required: 1, approvals_left: 0, approved_by: [{ user: f.userJson(f.person('grace')) }] });
  });

  it('a missing MR or project is a 404', () => {
    const f = fake();
    expect(() => f.mr('orbital/forge-lab', 99)).toThrow(FakeHttp);
    expect(() => f.project('nope/nope')).toThrow(FakeHttp);
  });

  it("parses Orbital's real forge.json and answers its MRs", async () => {
    const bundle = await readBundle(new Uint8Array(readFileSync(new URL('../../../../site/demo-data/orbital.gbdemo', import.meta.url))));
    const text = new TextDecoder().decode(bundle.files.find((f) => f.path === 'forge.json')!.data);
    const file = parseForgeFile(text);
    expect(file.gitlab.mergeRequests.length).toBeGreaterThan(0);
    const f = new FakeGitLab([file], () => '2026-10-04T12:30:00Z');
    for (const m of file.gitlab.mergeRequests) {
      expect(f.getMr(m.project, m.iid, { diverged: true, rebaseInProgress: true })).toMatchObject({ iid: m.iid });
      for (const d of m.discussions) expect(f.discussionJson(d)).toMatchObject({ id: d.id });
    }
    expect(f.listMrs(file.project, { state: 'all' }).length).toBe(file.gitlab.mergeRequests.filter((m) => m.project === file.project).length);
  });

  it('rejects a forge.json of another version or without a gitlab seed', () => {
    expect(() => parseForgeFile('{"version":2,"gitlab":{}}')).toThrow(/version 2/);
    expect(() => parseForgeFile('{"version":1}')).toThrow(/no gitlab/);
  });

  it('answers a project, its pipelines and an MR diff as GitLab does', () => {
    const f = fake();
    expect(f.projectJson(f.project('4242'))).toMatchObject({ id: 4242, name: 'forge-lab', path_with_namespace: 'orbital/forge-lab', namespace: { full_path: 'orbital' }, web_url: `${WEB}/orbital/forge-lab`, default_branch: 'main' });
    expect(f.pipelinesJson('orbital/forge-lab').map((p) => [p.id, p.status])).toEqual([[50_003, 'success'], [50_002, 'running'], [50_001, 'success']]);
    expect(f.diffsJson(f.mr('orbital/forge-lab', 1))).toEqual([expect.objectContaining({ old_path: 'src/hud.rs', new_file: false, renamed_file: false })]);
  });

  it('a second add merges without leaking into the caller or duplicating', () => {
    const file = forgeLabFile();
    file.gitlab.mergeRequests[0].rebaseInProgress = true;
    file.gitlab.uploads = ['a.png'];
    file.gitlab.files = { 'orbital/forge-lab': { 'a.md': 'a' } };
    const f = new FakeGitLab([file], () => '2026-10-04T12:30:00Z');
    expect(f.getMr('orbital/forge-lab', 1, { diverged: false, rebaseInProgress: true })).toMatchObject({ rebase_in_progress: true });
    expect(file.gitlab.mergeRequests[0].rebaseInProgress).toBe(true);
    const more = forgeLabFile();
    more.gitlab.uploads = ['a.png', 'b.png'];
    more.gitlab.files = { 'orbital/forge-lab': { 'b.md': 'b' } };
    f.add(more);
    expect(f.seed.mergeRequests).toHaveLength(6);
    expect(f.seed.uploads).toEqual(['a.png', 'b.png']);
    expect(f.seed.files['orbital/forge-lab']).toEqual({ 'a.md': 'a', 'b.md': 'b' });
  });
});
