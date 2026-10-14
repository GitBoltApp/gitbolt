import * as git from 'isomorphic-git';
import { describe, expect, it, vi } from 'vitest';
import { forgeReadHandlers as r } from '../handlers/forgeReads';
import { forgeWriteHandlers as w } from '../handlers/forgeWrites';
import { eolOf, MARK_END, MARK_START, renderBlock, spliceBlock } from './stack';
import { borrowingView } from '../engine/remote/objects';
import { listFiles } from '../engine/read/trees';
import { statusError } from './provider';
import { labCtx, labWithOrigin } from './testkit';

const opts = { method: null, squash: null, deleteSourceBranch: true, expectedSha: null };
const stack = ['feature/stack-a', 'feature/stack-b'];

describe('stacked MRs', () => {
  it('renders the table with the current row bold and splices it in place', () => {
    const block = renderBlock([{ number: 4, title: 'Add the cargo hold', state: 'open' }, { number: 5, title: 'Give | the *hold*', state: 'open' }], 5, '\n');
    expect(block).toBe([MARK_START, '**Stack** (kept up to date by GitVolt)', '', '| # | MR | Title | State |', '|---|---|---|---|', '| 1 | !4 | Add the cargo hold | Open |', '| **2** | **!5** | **Give \\| the \\*hold\\*** | **Open** |', MARK_END].join('\n'));
    const once = spliceBlock('Intro.', block);
    expect(once).toBe(`Intro.\n\n${block}`);
    expect(spliceBlock(once, block)).toBe(once);
  });

  it('keeps every byte outside the markers, drops later blocks, treats dangling markers as text, and escapes entities', () => {
    const block = renderBlock([{ number: 1, title: 'a <b>\nc', state: 'merged' }], 9, '\r\n');
    expect(block).toContain('| 1 | !1 | a &lt;b&gt; c | Merged |');
    const text = `Top\r\n${MARK_START}old${MARK_END}\r\nmid ${MARK_START} stray\r\n${MARK_START}x${MARK_END}tail`;
    expect(spliceBlock(text, block)).toBe(`Top\r\n${block}\r\nmid ${MARK_START} stray\r\ntail`);
    expect(spliceBlock('', block)).toBe(block);
    expect(spliceBlock('Line\r\n', block)).toBe(`Line\r\n\r\n${block}`);
    expect(eolOf('a\r\nb')).toBe('\r\n');
    expect(eolOf('a\nb')).toBe('\n');
  });

  it('the stack view, its sync, and a retarget', async () => {
    const { ctx, id } = await labCtx();
    const v = await w.forgeStack({ repo: id, branches: stack, base: 'main', baseRef: 'refs/remotes/origin/main' }, ctx);
    expect(v).toMatchObject({ remote: 'origin', project: 'orbital/forge-lab', kind: 'gitlab', mode: 'managed', members: [{ branch: 'feature/stack-a', targetBranch: 'main', mr: { number: 4 }, prefill: null }, { branch: 'feature/stack-b', targetBranch: 'feature/stack-a', mr: { number: 5 }, prefill: null }] });
    expect(await w.forgeSyncStack({ repo: id, branches: stack, base: 'main' }, ctx)).toEqual({ edited: [4, 5], unchanged: [], failed: [] });
    expect(await w.forgeSyncStack({ repo: id, branches: stack, base: 'main' }, ctx)).toEqual({ edited: [], unchanged: [4, 5], failed: [] });
    expect((await r.forgeMrDetail({ repo: id, number: 5 }, ctx)).value.mr.stacked).toBe(true);
    expect((await w.forgeRetarget({ repo: id, number: 5, target: 'main' }, ctx)).targetBranch).toBe('main');
  });

  it('merging the bottom of a stack that deletes its branch first points its dependents at its target', async () => {
    const { ctx, id, forge } = await labCtx();
    forge.gitEffects = false;
    await w.forgeMerge({ repo: id, number: 4, options: { method: null, squash: null, deleteSourceBranch: true, expectedSha: null } }, ctx);
    expect(forge.fake.mr('orbital/forge-lab', 5).targetBranch).toBe('main');
  });

  it('a merge that is refused puts the dependents back; one that keeps its branch moves nothing', async () => {
    const { ctx, id, forge } = await labCtx();
    forge.gitEffects = false;
    await expect(w.forgeMerge({ repo: id, number: 4, options: { ...opts, expectedSha: 'f'.repeat(40) } }, ctx)).rejects.toMatchObject({ message: '!4 changed since it was loaded: refresh and try again' });
    expect(forge.fake.mr('orbital/forge-lab', 5).targetBranch).toBe('feature/stack-a');
    forge.fake.seed.projects[0].settings = { ...forge.fake.seed.projects[0].settings, remove_source_branch_after_merge: false };
    await w.forgeMerge({ repo: id, number: 4, options: { ...opts, deleteSourceBranch: null } }, ctx);
    expect(forge.fake.mr('orbital/forge-lab', 5).targetBranch).toBe('feature/stack-a');
  });

  it('a member with no MR, on a branch with a merge in it, is prefilled from its oldest commit', async () => {
    const { ctx, id, t } = await labCtx();
    const fs = t.memfs;
    const dir = t.dir;
    await t.branch('feature/stack-c');
    await t.checkout('feature/stack-c');
    await t.write('radar.txt', 'ping\n');
    const c1 = await t.commit('Add the radar\n\nIt pings the cargo.\n\nSecond paragraph.');
    await t.write('side.txt', 'x\n');
    const s1 = await t.commit('Side work');
    await git.checkout({ fs, dir, ref: 'main', force: true });
    await t.branch('feature/side', c1);
    await t.checkout('feature/side');
    await t.write('side.txt', 'x\n');
    const x1 = await t.commit('Other work');
    const tree = (await git.readCommit({ fs, dir, oid: s1 })).commit.tree;
    const merge = await git.commit({ fs, dir, message: 'Merge side', tree, parent: [x1, s1], author: { name: 'Ada', email: 'ada@example.com' }, ref: 'refs/heads/feature/stack-c' });
    await t.checkout('main');
    expect(merge).not.toBe(s1);
    const v = await w.forgeStack({ repo: id, branches: ['feature/stack-c'], base: 'main', baseRef: 'refs/heads/main' }, ctx);
    expect(v.members[0]).toMatchObject({ mr: null, prefill: { title: 'Add the radar', description: 'It pings the cargo.\n\nSecond paragraph.' } });
    const missing = await w.forgeStack({ repo: id, branches: ['feature/none'], base: 'main', baseRef: 'refs/heads/main' }, ctx);
    expect(missing.members[0].prefill).toBeNull();
  });

  /** `feature/stack-b` (!5) one commit on `feature/stack-a`, pushed to the lab's origin. */
  async function withStackB(lab: Awaited<ReturnType<typeof labWithOrigin>>) {
    const { t, origin, forge } = lab;
    await t.checkout('feature/stack-a');
    await t.branch('feature/stack-b');
    await t.checkout('feature/stack-b');
    await t.write('capacity.txt', '40 t\n');
    const head = await t.commit('Give the hold a capacity');
    await t.checkout('main');
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/feature/stack-b', value: head, force: true });
    const mr5 = forge.fake.mr('orbital/forge-lab', 5);
    mr5.headSha = head;
    mr5.baseSha = await t.rev('feature/stack-a');
    mr5.hasConflicts = false;
    mr5.mergeStatus = 'mergeable';
    mr5.pipeline = 'success';
    return { head, mr5 };
  }
  const filesOn = async (lab: Awaited<ReturnType<typeof labWithOrigin>>, branch: string) => [...(await listFiles(await borrowingView(lab.t.memfs, lab.origin), await git.resolveRef({ fs: lab.t.memfs, gitdir: lab.origin, ref: `refs/heads/${branch}` }))).keys()];

  it('with the origin, merging the bottom retargets its dependent and rebuilds its diffs against main', async () => {
    const lab = await labWithOrigin();
    const { ctx, id, forge } = lab;
    const { mr5 } = await withStackB(lab);
    const stackA = forge.fake.mr('orbital/forge-lab', 4).headSha;
    await w.forgeMerge({ repo: id, number: 4, options: opts }, ctx);
    expect(mr5.targetBranch).toBe('main');
    // Worked out against main when it's next looked at, not by the merge.
    expect(mr5.diffs.map((d) => d.newPath)).toEqual(['README.md']);
    await r.forgeMrDetail({ repo: id, number: 5 }, ctx);
    // The diff's base is where !5's branch left main's history: !4's head, now merged in.
    expect(mr5.baseSha).toBe(stackA);
    expect(mr5.diffs.map((d) => d.newPath)).toEqual(['capacity.txt']);
    await w.forgeMerge({ repo: id, number: 5, options: opts }, ctx);
    expect(await filesOn(lab, 'main')).toEqual(expect.arrayContaining(['hold.txt', 'capacity.txt']));
    expect(forge.fake.mr('orbital/forge-lab', 4).state).toBe('merged');
  });

  it('merging the top first moves the branch under the bottom MR: merging that one loses nothing', async () => {
    const lab = await labWithOrigin();
    const { ctx, id, forge } = lab;
    const { mr5 } = await withStackB(lab);
    const mr4 = forge.fake.mr('orbital/forge-lab', 4);
    const before = mr4.headSha;
    await w.forgeMerge({ repo: id, number: 5, options: { ...opts, deleteSourceBranch: false } }, ctx);
    expect(mr5.state).toBe('merged');
    expect(mr4.headSha).not.toBe(before);
    expect(mr4.diffs.map((d) => d.newPath).sort()).toEqual(['capacity.txt', 'hold.txt']);
    mr4.pipeline = 'success';
    mr4.mergeStatus = 'mergeable';
    await w.forgeMerge({ repo: id, number: 4, options: opts }, ctx);
    expect(mr4.state).toBe('merged');
    expect((await filesOn(lab, 'main')).sort()).toEqual(expect.arrayContaining(['capacity.txt', 'hold.txt']));
  });

  it('a dependent that cannot be moved stops the merge, and the ones already moved go back', async () => {
    const { ctx, id, forge } = await labCtx();
    forge.gitEffects = false;
    const mr6 = forge.fake.mr('orbital/forge-lab', 6);
    mr6.targetBranch = 'feature/stack-a';
    // The newest activity moves first.
    mr6.updatedAt = '2027-01-01T00:00:00Z';
    const real = forge.provider.retarget.bind(forge.provider);
    const spy = vi.spyOn(forge.provider, 'retarget').mockImplementation((p, n, to) => {
      // !5's move fails, and !6 (moved first) can't go back.
      if ((n === 5 && to === 'main') || (n === 6 && to === 'feature/stack-a')) throw statusError(500, { message: '500 Internal Server Error' });
      return real(p, n, to);
    });
    await expect(w.forgeMerge({ repo: id, number: 4, options: opts }, ctx)).rejects.toMatchObject({ message: "Not merged: couldn't retarget !5 first (gitlab.example.com answered HTTP 500: 500 Internal Server Error) (!6 still targets main)" });
    expect(forge.fake.mr('orbital/forge-lab', 5).targetBranch).toBe('feature/stack-a');
    spy.mockRestore();
  });
});
