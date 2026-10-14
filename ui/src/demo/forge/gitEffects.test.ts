import * as git from 'isomorphic-git';
import { describe, expect, it, vi } from 'vitest';
import { readCommit } from '../engine/read/commitText';
import { forgeReadHandlers as r } from '../handlers/forgeReads';
import { forgeWriteHandlers as w } from '../handlers/forgeWrites';
import { remoteHandlers } from '../handlers/remotes';
import { borrowingView } from '../engine/remote/objects';
import { NO_EXPECT } from '../engine/writeSeam';
import { makeTestRepo } from '../engine/read/testkit';
import { gitlabDiffs, mergeWith } from './gitEffects';
import { mergeRefused, statusError } from './provider';
import { labWithOrigin } from './testkit';

const opts = { method: null, squash: null, deleteSourceBranch: null, expectedSha: null };
type Lab = Awaited<ReturnType<typeof labWithOrigin>>;

/** `lab`'s `feature/stack-a` one more commit (Lars, +0200) and `main` one (Grace, −0800), both
 * pushed; !4's head the branch's. The ids each forge write makes from here were checked against the
 * git binary (`git rebase`, `git merge --no-ff`, `commit-tree` for the squash). */
async function bothMoved({ t, origin, forge }: Lab, dock = 'dock.txt') {
  const { memfs: fs, dir } = t;
  const commitAs = async (file: string, text: string, message: string, who: { name: string; email: string; timestamp: number; timezoneOffset: number }) => {
    await t.write(file, text);
    await git.add({ fs, dir, filepath: file });
    return git.commit({ fs, dir, message, author: who, committer: who });
  };
  await t.checkout('feature/stack-a');
  const feat = await commitAs('weight.txt', '12 t\n', 'Weigh the cargo', { name: 'Lars Tidemann', email: 'lars@example.com', timestamp: 1_767_225_780, timezoneOffset: -120 });
  await t.checkout('main');
  const main = await commitAs(dock, dock === 'dock.txt' ? 'lights\n' : 'empty\n', 'Dock lights', { name: 'Grace Hopper', email: 'grace@example.com', timestamp: 1_767_225_840, timezoneOffset: 480 });
  await git.writeRef({ fs, gitdir: origin, ref: 'refs/heads/feature/stack-a', value: feat, force: true });
  await git.writeRef({ fs, gitdir: origin, ref: 'refs/heads/main', value: main, force: true });
  forge.fake.mr('orbital/forge-lab', 4).headSha = feat;
  return { feat, main };
}

const ref = ({ t, origin }: Lab, name: string) => git.resolveRef({ fs: t.memfs, gitdir: origin, ref: name });

describe('the forge acts on the origin', () => {
  it('a merge makes GitLab\'s merge commit on the origin and deletes the source', async () => {
    const { t, origin, ctx, id } = await labWithOrigin();
    const m = await w.forgeMerge({ repo: id, number: 4, options: { method: null, squash: null, deleteSourceBranch: true, expectedSha: null } }, ctx);
    expect(m.state).toBe('merged');
    const tip = await git.resolveRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/main' });
    // GitLab's commit is the origin's own until a fetch.
    const c = await readCommit(await borrowingView(t.memfs, origin), tip);
    expect(c.parents).toHaveLength(2);
    expect(c.rawMessage).toBe("Merge branch 'feature/stack-a' into 'main'\n\nAdd the cargo hold\n\nSee merge request orbital/forge-lab!4\n");
    await expect(git.resolveRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/feature/stack-a' })).rejects.toBeTruthy();
    expect((await remoteHandlers.fetch({ repo: id, background: false }, ctx))).toMatchObject({ changed: true });
  });

  it('a push to an MR\'s branch moves its head, runs its pipeline, and the server links the MR', async () => {
    const { t, ctx, id, wt, forge, timers } = await labWithOrigin();
    await t.checkout('feature/stack-a');
    await t.write('more.txt', 'more\n');
    const tip = await t.commit('More cargo');
    const p = await remoteHandlers.push({ repo: id, worktree: wt, branch: 'feature/stack-a', expect: NO_EXPECT }, ctx);
    expect(p.outcome.server).toEqual({ lines: 0, warning: null });
    const m = forge.fake.mr('orbital/forge-lab', 4);
    expect([m.headSha, m.pipeline]).toEqual([tip, 'running']);
    const said = ctx.events.find((e) => e.type === 'opRemote') as { lines: { text: string }[] };
    expect(said.lines.map((l) => l.text)).toEqual(['', 'View merge request for feature/stack-a:', '  https://gitlab.example.com/orbital/forge-lab/-/merge_requests/4', '']);
    timers.splice(0).forEach((f) => f());
    await vi.waitFor(() => expect(m.pipeline).toBe('success'));
  });

  it('the server offers a new merge request for any other branch, and says nothing for the default one', async () => {
    const lab = await labWithOrigin();
    const { t, ctx, id, wt, forge } = lab;
    // The hooks read a bundle loaded after the forge was made (a push before any forge read).
    forge.loaded.clear();
    forge.projectOf.clear();
    await t.branch('feature/ünï');
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'feature/ünï', target: { remote: 'origin', branch: 'feature/ünï' }, setUpstream: true, expect: NO_EXPECT }, ctx);
    await t.write('lights.txt', 'on\n');
    await t.commit('Lights');
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx);
    const said = ctx.events.filter((e) => e.type === 'opRemote') as { lines: { text: string }[] }[];
    expect(said.map((e) => e.lines.map((l) => l.text))).toEqual([['', 'To create a merge request for feature/ünï, visit:', '  https://gitlab.example.com/orbital/forge-lab/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2F%C3%BCn%C3%AF', '']]);
  });

  it('merges as git does when the target moved, and squashes onto the MR\'s base by its author', async () => {
    const plain = await labWithOrigin();
    const { main } = await bothMoved(plain);
    await w.forgeMerge({ repo: plain.id, number: 4, options: opts }, plain.ctx);
    expect(await ref(plain, 'refs/heads/main')).toBe('ca40830080781edc4e4846e5853c633a9deb220c');
    expect(plain.forge.fake.mr('orbital/forge-lab', 4).mergeCommitSha).toBe('ca40830080781edc4e4846e5853c633a9deb220c');
    expect(await ref(plain, 'refs/heads/feature/stack-a')).toBe('5ba90dea313a41526457fc0db86b84ac6a12ec18');

    const squashed = await labWithOrigin();
    await bothMoved(squashed);
    const m = await w.forgeMerge({ repo: squashed.id, number: 4, options: { ...opts, squash: true } }, squashed.ctx);
    expect(m.state).toBe('merged');
    const tip = await ref(squashed, 'refs/heads/main');
    expect(tip).toBe('115176834f1172d86ffa49325023641bdbfbbf16');
    expect((await readCommit(await borrowingView(squashed.t.memfs, squashed.origin), tip)).parents).toEqual([main, '919782e852f3df12cdecb56781a1a9531fdc9bbe']);
    expect(squashed.forge.fake.mr('orbital/forge-lab', 4).squashCommitSha).toBe('919782e852f3df12cdecb56781a1a9531fdc9bbe');
  });

  it('refuses to merge an MR that conflicts with its target on the origin', async () => {
    const lab = await labWithOrigin();
    const { main } = await bothMoved(lab, 'hold.txt');
    await expect(w.forgeMerge({ repo: lab.id, number: 4, options: opts }, lab.ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "GitLab can't merge !4 now: refresh to see why" });
    expect(await ref(lab, 'refs/heads/main')).toBe(main);
    expect((await r.forgeMrDetail({ repo: lab.id, number: 4 }, lab.ctx)).value).toMatchObject({ mr: { conflicts: true, state: 'open' }, mergeStatus: { kind: 'blocked' } });
  });

  it('GitLab\'s rebase replays the branch onto its target, authors and their zones kept, as git does', async () => {
    const lab = await labWithOrigin();
    const { feat, main } = await bothMoved(lab);
    const m = await w.forgeUpdateBranch({ repo: lab.id, number: 4, how: 'rebase', expectedSha: feat }, lab.ctx);
    const head = '792950639f2b08dfc8d5d7c633150bf31b1bbe04';
    expect(m).toMatchObject({ headSha: head, pipeline: { status: 'pending' } });
    expect(await ref(lab, 'refs/heads/feature/stack-a')).toBe(head);
    const rebased = await readCommit(lab.t.repo, head).catch(() => null);
    // The new commits are the origin's own until a fetch brings them.
    expect(rebased).toBeNull();
    await remoteHandlers.fetch({ repo: lab.id, background: false }, lab.ctx);
    const c = await readCommit(lab.t.repo, head);
    expect([c.author.name, c.parents]).toEqual(['Lars Tidemann', ['652be62b83cccb5bbd147493ce89a54f13512baa']]);
    expect((await readCommit(lab.t.repo, c.parents[0])).parents).toEqual([main]);
    const fake = lab.forge.fake.mr('orbital/forge-lab', 4);
    expect(fake.baseSha).toBe(main);
    lab.timers.splice(0).forEach((f) => f());
    await vi.waitFor(() => expect(fake.pipeline).toBe('success'));
  });

  it('a rebase that stops on conflicts fails as GitLab says, and moves nothing', async () => {
    const lab = await labWithOrigin();
    const { feat } = await bothMoved(lab, 'hold.txt');
    await expect(w.forgeUpdateBranch({ repo: lab.id, number: 4, how: 'rebaseSkipCi', expectedSha: feat }, lab.ctx)).rejects.toMatchObject({
      kind: 'InvalidInput', message: "GitLab couldn't rebase !4: Rebase failed: Rebase locally, resolve all conflicts, then push the branch.",
    });
    expect(await ref(lab, 'refs/heads/feature/stack-a')).toBe(feat);
    expect(lab.forge.fake.mr('orbital/forge-lab', 4)).toMatchObject({ headSha: feat, rebaseError: null });
    await expect(w.forgeUpdateBranch({ repo: lab.id, number: 4, how: 'merge', expectedSha: feat }, lab.ctx)).rejects.toMatchObject({ message: 'GitLab updates a source branch by rebasing it' });
  });

  it('auto-merge merges on the origin once the pipeline passes', async () => {
    const lab = await labWithOrigin();
    const fake = lab.forge.fake.mr('orbital/forge-lab', 4);
    fake.pipeline = 'running';
    fake.mergeStatus = 'ci_still_running';
    const set = await w.forgeSetAutoMerge({ repo: lab.id, number: 4, options: { ...opts, deleteSourceBranch: true } }, lab.ctx);
    expect(set).toMatchObject({ state: 'open', autoMerge: { enabledBy: { username: 'you' } } });
    expect(lab.timers).toHaveLength(1);
    lab.timers.splice(0).forEach((f) => f());
    await vi.waitFor(() => expect(fake.mergeCommitSha).not.toBe(''));
    expect(fake).toMatchObject({ state: 'merged', pipeline: 'success' });
    expect(await ref(lab, 'refs/heads/main')).toBe(fake.mergeCommitSha);
    await expect(ref(lab, 'refs/heads/feature/stack-a')).rejects.toBeTruthy();
  });

  it('a push to an MR\'s branch remakes its diffs: the new line is one to comment on', async () => {
    const { t, ctx, id, wt, forge } = await labWithOrigin();
    await t.checkout('feature/stack-a');
    await t.write('hold.txt', 'cargo\nmore cargo\n');
    const tip = await t.commit('More cargo');
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'feature/stack-a', expect: NO_EXPECT }, ctx);
    const m = forge.fake.mr('orbital/forge-lab', 4);
    expect(m.diffs).toEqual([{ oldPath: 'hold.txt', newPath: 'hold.txt', diff: '@@ -0,0 +1,2 @@\n+cargo\n+more cargo\n' }]);
    const d = await w.forgeReviewDiff({ repo: id, number: 4 }, ctx);
    expect(d.refs.headSha).toBe(tip);
    expect(d.files.map((f) => [f.path, f.lines.map((l) => [l.kind, l.newLine])])).toEqual([['hold.txt', [['added', 1], ['added', 2]]]]);
    const at = { position_type: 'text', base_sha: m.baseSha, start_sha: m.baseSha, head_sha: tip, new_path: 'hold.txt', old_path: 'hold.txt', new_line: 2, old_line: null };
    await expect(forge.fake.checkPosition(m, at)).resolves.toMatchObject({ newPath: 'hold.txt', newLine: 2 });
  });

  it('remakes diffs as `git diff -M -U3` prints them (checked on the binary)', async () => {
    const t = await makeTestRepo();
    await t.write('z.rs', 'fn one() {\n    a\n    b\n    c\n    d\n    e\n    f\n}\n');
    await t.write('m.txt', 'line1\nline2\nline3\nline4\nline5\nline6\n');
    await t.write('b.txt', 'gone\n');
    await t.write('a_old.txt', 'x1\nx2\nx3\nx4\nx5\n');
    const base = await t.commit('base');
    await t.write('z.rs', 'fn one() {\n    a\n    b\n    c\n    d\n    e\n    F\n}\n');
    await t.remove('b.txt');
    await t.remove('a_old.txt');
    await t.write('y_new.txt', 'x1\nx2\nx3\nx4\nx5\nx6\n');
    await t.write('c.txt', 'new\n');
    await t.write('m.txt', 'line1');
    const head = await t.commit('head');
    expect(await gitlabDiffs(t.repo, base, head)).toEqual([
      { oldPath: 'b.txt', newPath: 'b.txt', diff: '@@ -1 +0,0 @@\n-gone\n' },
      { oldPath: 'c.txt', newPath: 'c.txt', diff: '@@ -0,0 +1 @@\n+new\n' },
      { oldPath: 'm.txt', newPath: 'm.txt', diff: '@@ -1,6 +1 @@\n-line1\n-line2\n-line3\n-line4\n-line5\n-line6\n+line1\n\\ No newline at end of file\n' },
      { oldPath: 'a_old.txt', newPath: 'y_new.txt', diff: '@@ -3,3 +3,4 @@ x2\n x3\n x4\n x5\n+x6\n' },
      { oldPath: 'z.rs', newPath: 'z.rs', diff: '@@ -4,5 +4,5 @@ fn one() {\n     c\n     d\n     e\n-    f\n+    F\n }\n' },
    ]);
  });

  it('an auto-merge waiting for an approval merges when it comes', async () => {
    const lab = await labWithOrigin();
    const fake = lab.forge.fake.mr('orbital/forge-lab', 4);
    Object.assign(fake, { pipeline: 'running', approvedBy: [], mergeStatus: 'not_approved' });
    await w.forgeSetAutoMerge({ repo: lab.id, number: 4, options: opts }, lab.ctx);
    lab.timers.splice(0).forEach((f) => f());
    await vi.waitFor(() => expect(fake.pipeline).toBe('success'));
    expect(fake).toMatchObject({ state: 'opened', mergeStatus: 'not_approved', autoMergeBy: 'you' });
    await w.forgeApprove({ repo: lab.id, number: 4 }, lab.ctx);
    expect(fake.state).toBe('merged');
    expect(await ref(lab, 'refs/heads/main')).toBe(fake.mergeCommitSha);
  });

  it('a merge the origin can\'t take (its target moved into a conflict) is refused, and the MR is as it was', async () => {
    const lab = await labWithOrigin();
    const { main } = await bothMoved(lab, 'hold.txt');
    const project = lab.forge.provider.project('orbital/forge-lab');
    const refused = () => mergeRefused(4, statusError(405, { message: '405 Method Not Allowed' }));
    await expect(mergeWith(lab.ctx, lab.forge, 'orbital/forge-lab', 4, () => lab.forge.provider.merge(project, 4, { ...opts, squash: true }), refused)).rejects.toMatchObject({ message: "GitLab can't merge !4 now: refresh to see why" });
    expect(lab.forge.fake.mr('orbital/forge-lab', 4)).toMatchObject({ state: 'opened', squash: false, mergeCommitSha: '', squashCommitSha: '', hasConflicts: true, mergeStatus: 'conflict' });
    expect(await ref(lab, 'refs/heads/main')).toBe(main);
  });
});
