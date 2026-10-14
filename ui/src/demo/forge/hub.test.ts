import { readFileSync } from 'node:fs';
import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { makeTestRepo } from '../engine/read/testkit';
import { remoteRefs } from '../engine/remote/objects';
import { openForWrite } from '../engine/writeSeamTest';
import { forgeReadHandlers as h } from '../handlers/forgeReads';
import type { GraphRequest } from '../gen/GraphRequest';
import { readBundle } from '../engine/bundle';
import { graphHandlers } from '../handlers/graph';
import { noGraph } from '../testing';
import { FakeGitLab } from './fakeGitlab';
import { DemoGitLab, statusError } from './provider';
import { parseForgeFile } from './seed';
import { labCtx, labWithOrigin } from './testkit';

describe('the demo forge: reads', () => {
  it('has the visitor\'s account and maps origin to its project', async () => {
    const { ctx, id } = await labCtx();
    expect(await h.forgeAccounts(undefined, ctx)).toMatchObject([{ account: { host: 'gitlab.example.com', kind: 'gitlab', user: { username: 'you', name: 'You' } }, status: { kind: 'ok' } }]);
    const rp = await h.forgeRepoProjects({ repo: id, refresh: false }, ctx);
    expect(rp).toMatchObject({ target: 'origin', targetChosen: false, remotes: [{ remote: 'origin', account: 'gitlab', project: { path: 'orbital/forge-lab', webUrl: 'https://gitlab.example.com/orbital/forge-lab', cloneHttps: 'https://gitlab.example.com/orbital/forge-lab.git' } }] });
    // origin went from covered to a known root: the graph refreshes, once.
    expect(ctx.events).toEqual([{ type: 'refsUpdated', repo: id }]);
    await h.forgeRepoProjects({ repo: id, refresh: false }, ctx);
    expect(ctx.events).toHaveLength(1);
  });

  it('a lookup that learns the remotes\' forks refreshes the graph once, and the graph gets them', async () => {
    const requests: GraphRequest[] = [];
    const graph = () => ({ ...noGraph(), build: (req: GraphRequest) => (requests.push(req), noGraph().build(req)) });
    const { t, ctx, id, forge } = await labCtx({ graph });
    // A fork of the lab's project, as `origin`; the lab itself as `upstream`.
    forge.fake.seed.projects.push({ ...forge.fake.project('orbital/forge-lab'), id: 4243, path: 'ada/forge-lab', forkOf: 'orbital/forge-lab', httpUrl: null, sshUrl: null });
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.origin.url', value: 'https://gitlab.example.com/ada/forge-lab.git' });
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.upstream.url', value: 'git@gitlab.example.com:orbital/forge-lab.git' });
    await graphHandlers.graph({ repo: id, limit: null }, ctx).catch(() => undefined);
    expect(requests.at(-1)?.forks).toEqual({ parents: {}, roots: [], covered: ['origin', 'upstream'] });
    const rp = await h.forgeRepoProjects({ repo: id, refresh: false }, ctx);
    expect(rp.target).toBe('upstream');
    expect(ctx.events.filter((e) => e.type === 'refsUpdated')).toEqual([{ type: 'refsUpdated', repo: id }]);
    await h.forgeRepoProjects({ repo: id, refresh: true }, ctx);
    expect(ctx.events.filter((e) => e.type === 'refsUpdated')).toHaveLength(1);
    await graphHandlers.graph({ repo: id, limit: null }, ctx).catch(() => undefined);
    expect(requests.at(-1)?.forks).toEqual({ parents: { origin: 'upstream' }, roots: ['upstream'], covered: ['origin', 'upstream'] });
  });

  it('lists the open MRs with their pipelines, newest first', async () => {
    const { ctx, id } = await labCtx();
    const list = await h.forgeMrList({ repo: id, filter: 'all' }, ctx);
    expect(list.mrs.map((m) => [m.number, m.state])).toEqual([[6, 'open'], [5, 'open'], [4, 'open'], [2, 'draft'], [1, 'open']]);
    expect(list.mrs.find((m) => m.number === 1)!.pipeline).toEqual({ status: 'success', webUrl: 'https://gitlab.example.com/orbital/forge-lab/-/pipelines/50001' });
    expect(list.mrs.find((m) => m.number === 1)!.labelColors).toEqual({ hud: '#428bca' });
    expect((await h.forgeMrList({ repo: id, filter: 'reviewRequested' }, ctx)).mrs.map((m) => m.number)).toEqual([1]);
  });

  it('badges each remote ref, a non-ASCII source branch included', async () => {
    const { ctx, id } = await labCtx();
    expect(await h.forgeCachedMrs({ repo: id, refs: [], filter: 'all' }, ctx)).toBeNull();
    const b = await h.forgeBranchMrs({ repo: id, refs: ['refs/remotes/origin/feature/hud-scale', 'refs/remotes/origin/feature/ünï-names'] }, ctx);
    expect(b.mrs.map((x) => [x.remoteRef, x.mr.number])).toEqual(expect.arrayContaining([['refs/remotes/origin/feature/hud-scale', 1], ['refs/remotes/origin/feature/ünï-names', 6]]));
    expect((await h.forgeCachedMrs({ repo: id, refs: [], filter: 'all' }, ctx))?.badges?.mrs.length).toBeGreaterThan(0);
  });

  it('a merged MR badges its ref only while the ref is at its head; the trunk is never looked up', async () => {
    const { t, ctx, id, forge } = await labCtx();
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/fix/dock-chime', value: await t.rev('main') });
    const refs = ['refs/remotes/origin/fix/dock-chime', 'refs/remotes/origin/main'];
    let b = await h.forgeBranchMrs({ repo: id, refs }, ctx);
    expect(b.history.map((x) => [x.remoteRef, x.mr.number, x.mr.state])).toEqual([['refs/remotes/origin/fix/dock-chime', 3, 'merged']]);
    expect(b.mrs.some((x) => x.remoteRef === 'refs/remotes/origin/main')).toBe(false);
    // Its answer is kept while the ref stays put; once the ref moves (here, to the MR's head) it is asked again.
    const head = await t.commit('Chime');
    forge.fake.mr('orbital/forge-lab', 3).headSha = head;
    expect((await h.forgeBranchMrs({ repo: id, refs }, ctx)).history.map((x) => x.mr.number)).toEqual([3]);
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/fix/dock-chime', value: head, force: true });
    b = await h.forgeBranchMrs({ repo: id, refs }, ctx);
    expect(b.mrs.find((x) => x.mr.number === 3)?.remoteRef).toBe('refs/remotes/origin/fix/dock-chime');
  });

  it('an MR with its review, merge status and subscription; its threads with snippets and reactions', async () => {
    const { ctx, id } = await labCtx();
    const d = await h.forgeMrDetail({ repo: id, number: 1 }, ctx);
    expect(d.value).toMatchObject({ mergeStatus: { kind: 'blocked', reason: 'It needs approval first' }, subscribed: true, baseSha: 'b'.repeat(40), mr: { review: { decision: 'reviewRequired', approvalsRequired: 1 } }, update: { kinds: ['rebase', 'rebaseSkipCi'] } });
    const ds = (await h.forgeMrDiscussions({ repo: id, number: 1 }, ctx)).value;
    const diffNote = ds.find((x) => x.id === 'd2')!.notes[0];
    expect(diffNote.position).toMatchObject({ path: 'src/hud.rs', line: 8, snippet: "+\n+/// The HUD's scale for a window `height` pixels tall.\n+pub fn hud_scale(height: u32) -> u32 {" });
    expect(diffNote.reactions).toEqual([{ name: 'thumbsup', count: 1, mine: false, users: ['Grace Hopper'] }]);
    // Pre-flight F24: the fixture's resolvedAt is 2026-10-10T15:00:00Z.
    expect(ds.find((x) => x.id === 'd3')).toMatchObject({ resolved: true, resolvedBy: 'Grace Hopper', resolvedAt: 1_791_644_400 });
    await expect(h.forgeMrDetail({ repo: id, number: 99 }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'Not found on gitlab.example.com' });
  });

  it('a single MR\'s labels get their colours from the project\'s', async () => {
    const { ctx, id } = await labCtx();
    expect((await h.forgeMrDetail({ repo: id, number: 3 }, ctx)).value.mr).toMatchObject({ state: 'merged', labels: ['audio'], labelColors: { audio: '#d9534f' } });
  });

  it('settings, forks, people limits and a project by path', async () => {
    const { ctx, id } = await labCtx();
    expect(await h.forgeProjectSettings({ repo: id, remote: 'origin' }, ctx)).toMatchObject({ squash: 'defaultOff' });
    expect(await h.forgeForks({ repo: id, remote: 'origin', page: 1, perPage: 10 }, ctx)).toEqual({ forks: [], next: null });
    expect(await h.forgePeopleLimits({ repo: id, remote: 'origin' }, ctx)).toEqual({ maxReviewers: null, maxAssignees: null });
    expect(await h.forgeProjectByPath({ repo: id, path: 'orbital/forge-lab' }, ctx)).toMatchObject({ id: 4242 });
    await expect(h.forgeProjectByPath({ repo: id, path: 'orbital/nowhere' }, ctx)).rejects.toMatchObject({ kind: 'NotFound' });
    await expect(h.forgeProjectSettings({ repo: id, remote: 'upstream' }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'No remote upstream' });
  });

  it('a repository without a forge remote says so', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    const { ctx, id } = await openForWrite(t);
    await expect(h.forgeMrList({ repo: id, filter: 'all' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'This repository has no remote on a forge account: add one in Settings › Accounts' });
    expect(await h.forgeRepoProjects({ repo: id, refresh: false }, ctx)).toEqual({ remotes: [], target: null, targetChosen: false });
  });

  it('the origin serves each MR\'s head whose commit it has', async () => {
    const { t, origin, ctx } = await labWithOrigin();
    const refs = await remoteRefs(ctx, t.memfs, origin);
    expect(refs.get('refs/merge-requests/4/head')).toBe(await t.rev('feature/stack-a'));
    expect(refs.has('refs/merge-requests/1/head')).toBe(false);
  });

  it('refusals in the core\'s words', () => {
    expect(statusError(409, { message: ['a', 'b'] }).message).toBe('gitlab.example.com: a; b');
    expect(statusError(403, { message: '403 Forbidden' })).toMatchObject({ kind: 'AuthFailed', message: 'gitlab.example.com refused: 403 Forbidden' });
    expect(statusError(500, { message: ['', ' '], error: 'boom' }).message).toBe('gitlab.example.com answered HTTP 500: boom');
  });

  it("maps every one of Orbital's MRs and threads; a list reads one page, the badges five", async () => {
    const bundle = await readBundle(new Uint8Array(readFileSync(new URL('../../../../site/demo-data/orbital.gbdemo', import.meta.url))));
    const file = parseForgeFile(new TextDecoder().decode(bundle.files.find((f) => f.path === 'forge.json')!.data));
    const fake = new FakeGitLab([file], () => '2026-10-04T12:30:00Z');
    const gl = new DemoGitLab(fake);
    const p = gl.project(file.project);
    for (const m of file.gitlab.mergeRequests.filter((x) => x.project === file.project)) {
      expect(gl.mrDetail(p, m.iid).mr.number).toBe(m.iid);
      expect(gl.discussions(p, m.iid)).toHaveLength(m.discussions.length);
    }
    const open = fake.listMrs(file.project, { state: 'opened' }).length;
    expect(gl.openMrs(p, 'all', true)).toHaveLength(Math.min(100, open));
    expect(gl.openMrs(p, 'all', false)).toHaveLength(Math.min(500, open));
  });
});
