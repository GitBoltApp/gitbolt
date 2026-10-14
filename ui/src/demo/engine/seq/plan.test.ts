import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { addWorktree, makeTestRepo } from '../read/testkit';
import { irebaseShape, rebaseLab } from './fixtures';
import { rebasePlan, readRange } from './plan';

describe('rebasePlan', () => {
  it('lists the flattened rows newest first with the stack chips', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    await git.deleteRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/side' });
    const p = await rebasePlan(t.repo, t.dir, 'feature/c', 'main');
    expect(p.rows.map((r) => r.summary)).toEqual(['C2 Polish', 'C1 Edit notes again', 'B2 Refine lexer', 'S1 Side work', 'B1 Add lexer', 'A3 Add tests', 'A2 Edit notes', 'A1 Add parser']);
    expect(p.merges).toBe(1);
    expect(p.behind).toBe(1);
    expect(p.chips).toEqual([
      { branch: 'feature/a', at: await t.rev('feature/a'), locked: null },
      { branch: 'feature/b', at: await t.rev('feature/b'), locked: null },
    ]);
    expect(p.baseOid).toBe(await t.rev('main'));
    expect(p.baseSummary).toBe('Main moves');
    expect(p.baseChips).toEqual(['main']);
    expect(p.branches).toEqual(['feature/a', 'feature/b', 'feature/c', 'main']);
    expect(p.expect).toEqual({ 'refs/heads/feature/c': await t.rev('feature/c'), 'refs/heads/feature/a': await t.rev('feature/a'), 'refs/heads/feature/b': await t.rev('feature/b'), 'refs/heads/main': await t.rev('main') });
    expect(Object.keys(p.expect)).toEqual(['refs/heads/feature/a', 'refs/heads/feature/b', 'refs/heads/feature/c', 'refs/heads/main']);
    expect(p.rows[0]).toMatchObject({ message: 'C2 Polish\n', authorName: 'Ada Lovelace', authorEmail: 'ada@example.com', upstream: false });
    expect(p.rows.every((r) => !r.upstream)).toBe(true);
  });

  it('a merged-in branch is locked on the newest row below its tip', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    const p = await rebasePlan(t.repo, t.dir, 'feature/c', 'main');
    const side = p.chips.find((c) => c.branch === 'side')!;
    expect(side.locked).toBe('merged in: it stays where it is');
    expect(p.rows.find((r) => r.oid === side.at)!.summary).toBe('S1 Side work');
    expect(p.chips.map((c) => c.branch)).toEqual(['feature/a', 'feature/b', 'side']);
  });

  it('a chip on a merge commit sits on the newest row below it', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    await t.branch('on-merge', (await git.readCommit({ fs: t.memfs, dir: t.dir, oid: await t.rev('feature/b') })).commit.parent[0]);
    const p = await rebasePlan(t.repo, t.dir, 'feature/c', 'main');
    const chip = p.chips.find((c) => c.branch === 'on-merge')!;
    expect(chip.locked).toBeNull();
    expect(p.rows.find((r) => r.oid === chip.at)!.summary).toBe('S1 Side work');
  });

  it('a branch checked out in another worktree is a locked chip', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    const path = await addWorktree(t, 'a', 'feature/a');
    const r = await readRange(t.repo, t.dir, 'feature/c', 'main', 1000);
    expect(r.locked.get('feature/a')).toBe(`checked out in ${path}`);
    expect(r.chips.find((c) => c.branch === 'feature/a')!.locked).toBe(`checked out in ${path}`);
  });

  it('marks a row the base already has', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    await t.checkout('main');
    await t.write('file_1.txt', 'L1 Add parser\n');
    await t.commit('L1 Add parser (picked)');
    const p = await rebasePlan(t.repo, t.dir, 'lab', 'main');
    expect(p.rows.find((r) => r.summary === 'L1 Add parser')!.upstream).toBe(true);
    expect(p.rows.filter((r) => r.upstream)).toHaveLength(1);
    expect(p.behind).toBe(2);
  });

  // `rev-list --cherry-mark` on the binary: an empty commit is `=` when the base's side has an
  // empty commit too, `+` when it doesn't.
  it('an empty row is upstream only when the base has an empty commit', async () => {
    const t = await makeTestRepo();
    await t.write('f.txt', 'a\n');
    await t.commit('Base');
    await t.branch('topic');
    await t.checkout('topic');
    await t.commit('Empty on topic');
    await t.checkout('main');
    await t.write('m.txt', 'm\n');
    await t.commit('Main moves');
    expect((await rebasePlan(t.repo, t.dir, 'topic', 'main')).rows.map((r) => r.upstream)).toEqual([false]);
    await t.commit('Empty on main');
    expect((await rebasePlan(t.repo, t.dir, 'topic', 'main')).rows.map((r) => r.upstream)).toEqual([true]);
  });

  // `git log --topo-order --no-merges main..t` on the same shape (git 2.53): t4 s4a s3a t3 s1b s1a t2 t1.
  it('orders rows as git log --topo-order with several merged-in lines', async () => {
    const t = await makeTestRepo();
    const c = async (s: string) => {
      await t.write(`${s}.txt`, `${s}\n`);
      return t.commit(s);
    };
    const merge = async (s: string, other: string) => {
      const ours = await t.rev('HEAD');
      await t.checkout(other);
      const theirs = await t.rev('HEAD');
      const files = (await git.listFiles({ fs: t.memfs, dir: t.dir, ref: theirs })).filter((f) => f !== 'base.txt');
      const contents = await Promise.all(files.map(async (f) => [f, t.memfs.readFileSync(`${t.dir}/${f}`, 'utf8') as string] as const));
      await t.checkout('t');
      for (const [f, text] of contents) await t.write(f, text);
      await t.commit(s, undefined, { parents: [ours, theirs] });
    };
    await c('base');
    await t.branch('t');
    await t.checkout('t');
    await c('t1');
    await t.branch('s1');
    await t.checkout('s1');
    await c('s1a');
    await c('s1b');
    await t.branch('s3', await t.rev('t'));
    await t.checkout('s3');
    await c('s3a');
    await t.checkout('t');
    await c('t2');
    await merge('m1', 's1');
    await c('t3');
    await merge('m2', 's3');
    await t.branch('s4', await t.rev('s1'));
    await t.checkout('s4');
    await c('s4a');
    await t.checkout('t');
    await merge('m3', 's4');
    await c('t4');
    await t.checkout('main');
    await c('mainmove');
    const p = await rebasePlan(t.repo, t.dir, 't', 'main');
    expect(p.rows.map((r) => r.summary)).toEqual(['t4', 's4a', 's3a', 't3', 's1b', 's1a', 't2', 't1']);
    expect(p.merges).toBe(3);
    expect(p.behind).toBe(1);
  });

  it('keeps the message as stored; the summary is its first line', async () => {
    const t = await makeTestRepo();
    await t.write('f.txt', 'a\n');
    const base = await t.commit('Base');
    // Raw commits: isomorphic-git's own commit would tidy these messages.
    const raw = async (parent: string, message: string) => {
      const { commit } = await git.readCommit({ fs: t.memfs, dir: t.dir, oid: parent });
      const who = 'Ada Lovelace <ada@example.com> 1767225600 +0000';
      const text = `tree ${commit.tree}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${message}`;
      return git.writeObject({ fs: t.memfs, dir: t.dir, type: 'commit', object: new TextEncoder().encode(text), format: 'content' });
    };
    const top = await raw(await raw(base, 'Subject\r\n\r\nBody\r\n'), '\nLeading blank, no newline');
    await t.branch('topic', top);
    await t.commit('Main moves');
    const p = await rebasePlan(t.repo, t.dir, 'topic', 'main');
    expect(p.rows.map((r) => [r.summary, r.message])).toEqual([['', '\nLeading blank, no newline'], ['Subject', 'Subject\r\n\r\nBody\r\n']]);
  });

  it('an annotated tag as the base expects the tag object; an oid names no ref', async () => {
    const t = await makeTestRepo();
    await irebaseShape(t);
    const main = await t.rev('main');
    await git.annotatedTag({ fs: t.memfs, dir: t.dir, ref: 'v1.0', object: main, message: 'Release 1.0', tagger: { name: 'Ada Lovelace', email: 'ada@example.com', timestamp: 1_767_225_600, timezoneOffset: 0 } });
    const tag = await t.rev('refs/tags/v1.0');
    expect(tag).not.toBe(main);
    const p = await rebasePlan(t.repo, t.dir, 'feature/c', 'v1.0');
    expect(p.baseOid).toBe(main);
    expect(p.baseChips).toEqual(['main']);
    expect(p.expect['refs/tags/v1.0']).toBe(tag);
    expect(p.expect['refs/heads/main']).toBeUndefined();
    const byOid = await rebasePlan(t.repo, t.dir, 'feature/c', main);
    expect(Object.keys(byOid.expect)).toEqual(['refs/heads/feature/a', 'refs/heads/feature/b', 'refs/heads/feature/c', 'refs/heads/side']);
  });

  it('refuses more rows than the editor takes, an unknown branch and an unknown base', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    await expect(readRange(t.repo, t.dir, 'lab', 'main', 3)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Over 3 commits between main and lab: the editor takes up to 3' });
    await expect(rebasePlan(t.repo, t.dir, 'nope', 'main')).rejects.toMatchObject({ kind: 'NotFound', message: 'No branch nope' });
    await expect(rebasePlan(t.repo, t.dir, 'lab', 'nope')).rejects.toMatchObject({ kind: 'NotFound', message: 'nope: no such commit' });
  });
});
