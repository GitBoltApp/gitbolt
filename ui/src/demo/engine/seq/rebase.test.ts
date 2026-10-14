import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { readCommit } from '../read/commitText';
import { igNoCache } from '../read/seam';
import { makeTestRepo, type TestRepo } from '../read/testkit';
import { readInProgress, NO_EXPECT } from '../writeSeam';
import { openForWrite } from '../writeSeamTest';
import { integrateHandlers } from '../../handlers/integrate';
import { plainSteps, rebaseIntegrate } from './rebase';
import { irebaseShape, rebaseLab, stackShape, subjects } from './fixtures';
import type { Step } from './state';

async function rebase(t: TestRepo, target: string, updateRefs?: boolean) {
  const { ctx, id, wt } = await openForWrite(t);
  return { r: await rebaseIntegrate(ctx, { repo: id, worktree: wt, target, updateRefs, expect: NO_EXPECT, confirm: { autostash: false } }), ctx, id, wt };
}

const summary = async (t: TestRepo, oid: string) => (await readCommit(t.repo, oid)).summary;

/** A step as git's todo line starts: the commit's subject for a pick, `merge <subject>`, the
 *  ref of an update-ref, the command word of any other line. */
async function todo(t: TestRepo, steps: Step[]): Promise<string[]> {
  return Promise.all(
    steps.map(async (s) => {
      if (s.op === 'pick') return summary(t, s.oid);
      if (s.op === 'merge') return `merge ${await summary(t, s.oid)}`;
      if (s.op === 'updateRef') return `update-ref ${s.ref}`;
      if (s.op === 'line') return s.text.startsWith('update-ref') ? s.text : s.text.split(' ')[0];
      return s.op;
    }),
  );
}

describe('plain rebase', () => {
  it('moves a stack together', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const { r } = await rebase(t, 'main', true);
    expect(r.outcome).toEqual({ status: 'done', commits: 3, fastForward: false });
    expect(await subjects(t, 'main', 'feature/c')).toEqual(['Work on feature/a', 'Work on feature/b', 'Work on feature/c']);
    expect(await subjects(t, 'main', 'feature/a')).toEqual(['Work on feature/a']);
    expect(r.journal.paused).toBeNull();
  });

  // The core's: the request's choice, else `rebase.updateRefs`, else none (the UI always sends one).
  it('unasked, moves the stack only when rebase.updateRefs says so; unticked, only the checked-out branch moves', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const a = await t.rev('feature/a');
    await rebase(t, 'main');
    expect(await t.rev('feature/a')).toBe(a);
    const u = await makeTestRepo();
    await stackShape(u);
    await git.setConfig({ ...igNoCache(u.repo), path: 'rebase.updateRefs', value: 'true' });
    await rebase(u, 'main');
    expect(await subjects(u, 'main', 'feature/a')).toEqual(['Work on feature/a']);
    const v = await makeTestRepo();
    await stackShape(v);
    await git.setConfig({ ...igNoCache(v.repo), path: 'rebase.updateRefs', value: 'true' });
    const va = await v.rev('feature/a');
    await rebase(v, 'main', false);
    expect(await v.rev('feature/a')).toBe(va);
  });

  it('stops on a conflict and pauses on the target', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const { r } = await rebase(t, 'main');
    expect(r.outcome).toEqual({ status: 'stopped', kind: 'rebase', files: 1 });
    expect(r.journal.paused).toMatchObject({ kind: 'rebase', target: 'main' });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ kind: 'rebase', gitvolt: false, step: 2, total: 6 });
  });

  // git 2.53's `msgnum`/`end` at the same stops: update-ref lines count, and with merges the
  // label/reset lines and a merged-in branch's update-ref too.
  it('counts its steps as git does', async () => {
    const t = await makeTestRepo();
    await t.write('base.txt', 'b\n');
    await t.commit('Base');
    for (const [b, file, text] of [['feature/a', 'a.txt', 'a'], ['feature/b', 'm.txt', 'b'], ['feature/c', 'c.txt', 'c']]) {
      await t.branch(b);
      await t.checkout(b);
      await t.write(file, `${text}\n`);
      await t.commit(`Work on ${b}`);
    }
    await t.checkout('main');
    await t.write('m.txt', 'm\n');
    await t.commit('Main moves');
    await t.checkout('feature/c');
    const { ctx } = await rebase(t, 'main', true);
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ step: 3, total: 5 });
    // The paused entry knows the stack as it was (the core's `watch_refs`), for the Continue that moves it.
    expect(ctx.writes.journal(t.dir).paused()?.paused?.refsBefore.get('refs/heads/feature/b')).toBe(await t.rev('feature/b'));

    for (const [updateRefs, total] of [[true, 17], [false, 14]] as const) {
      const u = await makeTestRepo();
      await irebaseShape(u);
      await u.checkout('main');
      await u.write('notes.txt', 'one\nmain\n');
      await u.commit('main notes');
      await u.checkout('feature/c');
      const { r } = await rebase(u, 'main', updateRefs);
      expect(r.outcome).toMatchObject({ status: 'stopped', files: 1 });
      const a2 = (await readCommit(u.repo, await u.rev('feature/a'))).parents[0];
      expect(readInProgress(u.memfs, u.repo.gitdir)).toMatchObject({ step: 4, total, stoppedAt: a2 });
    }
  });

  it('a branch behind its target fast-forwards; one on it is up to date', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    await t.checkout('feature/a');
    const { r } = await rebase(t, 'feature/c');
    expect(r.outcome).toEqual({ status: 'done', commits: 2, fastForward: true });
    const again = await rebase(t, 'main~1');
    expect(again.r.outcome).toEqual({ status: 'upToDate' });
  });

  it('leaves out a commit the target already has, and keeps one that started empty', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    await t.checkout('main');
    await t.write('file_2.txt', 'Work on feature/a\n');
    await t.commit('Work on feature/a (picked)');
    await t.commit('Empty one');
    await t.checkout('feature/c');
    await t.commit('Empty one');
    const a = await t.rev('feature/a');
    const { r } = await rebase(t, 'main', true);
    expect(r.outcome).toEqual({ status: 'done', commits: 3, fastForward: false });
    expect(await subjects(t, 'main', 'feature/c')).toEqual(['Work on feature/b', 'Work on feature/c', 'Empty one']);
    // Its branch had no update-ref line left (git's todo drops the pick and the line).
    expect(await t.rev('feature/a')).toBe(a);
  });

  it('remakes the merges, the merged-in branch left where it was', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    const side = await t.rev('side');
    const { r } = await rebase(t, 'main', true);
    expect(r.outcome).toEqual({ status: 'done', commits: 9, fastForward: false });
    expect(await subjects(t, 'main', 'feature/c')).toEqual(['A1 Add parser', 'A2 Edit notes', 'A3 Add tests', 'B1 Add lexer', 'Merge side', 'B2 Refine lexer', 'C1 Edit notes again', 'C2 Polish']);
    expect(await subjects(t, 'main', 'feature/b')).toEqual(['A1 Add parser', 'A2 Edit notes', 'A3 Add tests', 'B1 Add lexer', 'Merge side', 'B2 Refine lexer']);
    const merge = await readCommit(t.repo, (await readCommit(t.repo, await t.rev('feature/b'))).parents[0]);
    const s1 = await readCommit(t.repo, merge.parents[1]);
    expect([s1.summary, s1.parents[0]]).toEqual(['S1 Side work', merge.parents[0]]);
    expect(await t.rev('side')).toBe(side);
  });

  // The todo git 2.53 writes for these shapes (`rebase -i --rebase-merges`, Task 5 ledger e5–e7).
  it('lays out a rebase with merges as git\'s todo', async () => {
    const t = await makeTestRepo();
    const file = async (name: string) => t.write(name, `${name}\n`);
    await file('n');
    await t.commit('Base');
    await t.branch('topic');
    await t.checkout('topic');
    await file('t1');
    const t1 = await t.commit('T1');
    await t.branch('side1');
    await t.checkout('side1');
    await file('s1a');
    await t.commit('S1a');
    await file('s1b');
    const s1b = await t.commit('S1b');
    await t.checkout('topic');
    await file('s1a');
    await file('s1b');
    await t.commit('Merge side1', undefined, { parents: [t1, s1b] });
    await file('t2');
    const t2 = await t.commit('T2');
    await t.branch('side2', await t.rev('main'));
    await t.checkout('side2');
    await file('s2');
    await t.commit('S2');
    await t.branch('side4');
    await t.checkout('side4');
    await file('s4');
    const s4 = await t.commit('S4');
    await t.checkout('side2');
    await file('s2b');
    const s2b = await t.commit('S2b');
    await file('s4');
    const m4 = await t.commit('Merge side4', undefined, { parents: [s2b, s4] });
    await t.checkout('topic');
    for (const f of ['s2', 's4', 's2b']) await file(f);
    await t.commit('Merge side2', undefined, { parents: [t2, m4] });
    await file('t3');
    await t.commit('T3');
    await t.branch('at-t1', t1);
    await t.branch('alpha', t1);
    await t.checkout('main');
    await file('m');
    await t.commit('Main');
    const { steps } = await plainSteps(t.repo, await t.rev('topic'), await t.rev('main'), [['refs/heads/alpha', t1], ['refs/heads/at-t1', t1]], [['refs/heads/side1', s1b]]);
    expect(await todo(t, steps)).toEqual([
      'label', 'reset', 'T1', 'update-ref refs/heads/at-t1', 'update-ref refs/heads/alpha', 'label', 'S1a', 'S1b', 'update-ref refs/heads/side1', 'label',
      'reset', 'S2', 'label', 'S4', 'label',
      'reset', 'S2b', 'merge Merge side4', 'label',
      'reset', 'merge Merge side1', 'T2', 'merge Merge side2', 'T3',
    ]);
  });

  // git keeps a line that didn't start on a merge base where it was (no `--rebase-cousins`), and
  // takes a merge's parent on a merge base to the target (Task 5 ledger e6, e6b).
  it('keeps a cousin line where it started, and moves a merge of the target onto it', async () => {
    const t = await makeTestRepo();
    await t.write('n', 'one\n');
    await t.commit('Base');
    await t.write('x', 'x\n');
    const x = await t.commit('X');
    await t.write('y', 'y\n');
    await t.commit('Y');
    await t.branch('topic');
    await t.checkout('topic');
    await t.write('t1', 't1\n');
    const t1 = await t.commit('T1');
    await t.branch('side', x);
    await t.checkout('side');
    await t.write('s1', 's1\n');
    const s1 = await t.commit('S1');
    await t.checkout('topic');
    await t.write('s1', 's1\n');
    await t.commit('Merge side', undefined, { parents: [t1, s1] });
    await t.write('t2', 't2\n');
    await t.commit('T2');
    await t.checkout('main');
    await t.write('m', 'm\n');
    await t.commit('Main');
    await t.checkout('topic');
    await rebase(t, 'main');
    expect(await subjects(t, 'main', 'topic')).toEqual(['T1', 'Merge side', 'T2']);
    const merge = await readCommit(t.repo, (await readCommit(t.repo, await t.rev('topic'))).parents[0]);
    expect(merge.parents[1]).toBe(s1);

    const u = await makeTestRepo();
    await u.write('n', 'one\n');
    const base = await u.commit('Base');
    await u.branch('topic');
    await u.checkout('topic');
    await u.write('t1', 't1\n');
    const ut1 = await u.commit('T1');
    await u.checkout('main');
    await u.write('x', 'x\n');
    const ux = await u.commit('X');
    await u.checkout('topic');
    await u.write('x', 'x\n');
    await u.commit('Merge main', undefined, { parents: [ut1, ux] });
    await u.write('t2', 't2\n');
    await u.commit('T2');
    await u.checkout('main');
    await u.write('m', 'm\n');
    const main = await u.commit('Main');
    await u.checkout('topic');
    const { r } = await rebase(u, 'main');
    expect(r.outcome).toEqual({ status: 'done', commits: 3, fastForward: false });
    const um = await readCommit(u.repo, (await readCommit(u.repo, await u.rev('topic'))).parents[0]);
    expect(um.parents).toEqual([ut1, main]);
    expect((await readCommit(u.repo, ut1)).parents).toEqual([base]);
  });

  it('pauses on a pick git refuses, its error the warning', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    await t.branch('topic');
    await t.checkout('topic');
    await t.write('p.txt', 'p\n');
    await t.commit('Add p');
    await t.remove('p.txt');
    await t.commit('Remove p');
    await t.checkout('main');
    await t.write('m.txt', 'm\n');
    await t.commit('Main moves');
    await t.checkout('topic');
    await t.write('p.txt', 'mine\n');
    const { r } = await rebase(t, 'main');
    expect(r.outcome).toMatchObject({ status: 'stopped', kind: 'rebase', files: 0, warning: 'The rebase stopped: The following untracked working tree files would be overwritten by merge:' });
    expect(r.journal.paused).toMatchObject({ kind: 'rebase', target: 'main' });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ kind: 'rebase', step: 1, total: 2 });
  });

  // Review evidence r5/eq1: git's todo is `label onto / reset onto / label side / reset onto /
  // pick T1 / merge -C M side / pick T2`, and the merge is already up to date: T1', T2'.
  it('makes no merge of a merged-in line the target already has', async () => {
    const t = await makeTestRepo();
    await t.write('n', 'n\n');
    const base = await t.commit('Base');
    await t.branch('side');
    await t.checkout('side');
    await t.write('s1', 's1\n');
    const s1 = await t.commit('S1');
    await t.checkout('main');
    await t.write('m', 'm\n');
    await t.commit('Main');
    await t.write('s1', 's1\n');
    await t.commit('S1 picked');
    await t.branch('topic', base);
    await t.checkout('topic');
    await t.write('t1', 't1\n');
    const t1 = await t.commit('T1');
    await t.write('s1', 's1\n');
    await t.commit('Merge side', undefined, { parents: [t1, s1] });
    await t.write('t2', 't2\n');
    await t.commit('T2');
    const { steps } = await plainSteps(t.repo, await t.rev('topic'), await t.rev('main'), []);
    expect(await todo(t, steps)).toEqual(['label', 'reset', 'label', 'reset', 'T1', 'merge Merge side', 'T2']);
    const { r } = await rebase(t, 'main');
    expect(r.outcome).toEqual({ status: 'done', commits: 2, fastForward: false });
    expect(await subjects(t, 'main', 'topic')).toEqual(['T1', 'T2']);
    expect((await readCommit(t.repo, await t.rev('topic'))).parents).toHaveLength(1);
  });

  it('sets ORIG_HEAD as it starts, and refuses an unborn branch as git does', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const c = await t.rev('feature/c');
    await rebase(t, 'main');
    expect(t.memfs.readFileSync(`${t.repo.gitdir}/ORIG_HEAD`, 'utf8')).toBe(`${c}\n`);
    const u = await makeTestRepo();
    await stackShape(u);
    await u.checkout('feature/a');
    const a = await u.rev('feature/a');
    expect((await rebase(u, 'feature/c')).r.outcome).toMatchObject({ fastForward: true });
    expect(u.memfs.readFileSync(`${u.repo.gitdir}/ORIG_HEAD`, 'utf8')).toBe(`${a}\n`);
    // An orphan branch with nothing staged (with files staged, the autostash's `git stash` fails first).
    const e = await makeTestRepo();
    await e.write('a.txt', 'a\n');
    await e.commit('Base');
    e.memfs.writeFileSync(`${e.repo.gitdir}/HEAD`, 'ref: refs/heads/empty\n');
    await e.remove('a.txt');
    e.memfs.unlinkSync(`${e.repo.gitdir}/index`);
    await expect(rebase(e, 'main')).rejects.toMatchObject({ kind: 'Other', message: 'Could not resolve HEAD to a commit' });
  });

  // The core refuses a merge of an unrelated history: there's no merge base to remerge it from
  // (git would rebase the other root too, as `reset [new root]`).
  it('refuses a merge of an unrelated history', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    await t.branch('topic');
    await t.checkout('topic');
    await t.write('b.txt', 'b\n');
    const b = await t.commit('B');
    t.memfs.writeFileSync(`${t.repo.gitdir}/HEAD`, 'ref: refs/heads/other\n');
    await t.remove('a.txt');
    await t.remove('b.txt');
    await t.write('o.txt', 'o\n');
    const o = await t.commit('O1');
    expect((await readCommit(t.repo, o)).parents).toEqual([]);
    await t.checkout('topic');
    await t.write('o.txt', 'o\n');
    const m = await t.commit('Merge other', undefined, { parents: [b, o] });
    await t.checkout('main');
    await t.write('m.txt', 'm\n');
    await t.commit('Main moves');
    await t.checkout('topic');
    const message = `topic has a merge commit with changes of its own (${m.slice(0, 7)} Merge other); a rebase would drop them. Merge main into topic instead`;
    await expect(rebase(t, 'main')).rejects.toMatchObject({ kind: 'InvalidInput', message });
    const { ctx, id, wt } = await openForWrite(t);
    expect((await integrateHandlers.integratePreview({ repo: id, worktree: wt, kind: 'rebase', target: 'main' }, ctx)).lossyMerge).toBe(message);
  });

  it('refuses a merge with changes of its own, and the preview says so', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const base = await t.commit('Base');
    await t.branch('topic');
    await t.checkout('topic');
    await t.write('b.txt', 'b\n');
    const b = await t.commit('B');
    await t.branch('side', base);
    await t.checkout('side');
    await t.write('s.txt', 's\n');
    const side = await t.commit('S');
    await t.checkout('topic');
    await t.write('s.txt', 's\n');
    await t.write('evil.txt', 'made in the merge\n');
    const m = await t.commit('Merge side', undefined, { parents: [b, side] });
    await t.checkout('main');
    await t.write('m.txt', 'm\n');
    await t.commit('Main moves');
    await t.checkout('topic');
    await expect(rebase(t, 'main')).rejects.toMatchObject({ kind: 'InvalidInput', message: `topic has a merge commit with changes of its own (${m.slice(0, 7)} Merge side); a rebase would drop them. Merge main into topic instead` });
    const { ctx, id, wt } = await openForWrite(t);
    const p = await integrateHandlers.integratePreview({ repo: id, worktree: wt, kind: 'rebase', target: 'main' }, ctx);
    expect(p.lossyMerge).toBe(`topic has a merge commit with changes of its own (${m.slice(0, 7)} Merge side); a rebase would drop them. Merge main into topic instead`);
    expect((await integrateHandlers.integratePreview({ repo: id, worktree: wt, kind: 'merge', target: 'main' }, ctx)).lossyMerge).toBeNull();
  });
});
