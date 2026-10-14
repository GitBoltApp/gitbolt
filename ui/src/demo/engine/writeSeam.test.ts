import { describe, expect, it } from 'vitest';
import { readCommit } from './read/commitText';
import { makeTestRepo, ADA } from './read/testkit';
import { rawAuthor } from './write/objects';
import { beginOp, mergeTrees, NO_EXPECT, notePaused, nowSeconds, readInProgress, runWrite, setHead, updateRef, withQueueSlot, writeCommitObject, type WriteIntent } from './writeSeam';
import { openForWrite } from './writeSeamTest';

describe('the phase-3 seam', () => {
  it('commits as the visitor at the parity clock, and moves a tracking ref with its reflog', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    const base = await t.commit('Base', ADA);
    const { ctx } = await openForWrite(t);
    const tree = (await readCommit(t.repo, base)).tree;
    const c = await writeCommitObject(t.repo, { tree, parents: [base], message: 'Again\n' }, ctx);
    const parsed = await readCommit(t.repo, c);
    expect(parsed.author).toEqual({ name: 'You', email: 'you@example.com', time: 1_800_000_000 });
    expect(parsed.parents).toEqual([base]);
    await updateRef(t.repo, t.repo.gitdir, 'refs/remotes/origin/main', null, c, 'update by push', nowSeconds(ctx));
    expect(await t.rev('refs/remotes/origin/main')).toBe(c);
    expect(t.memfs.readFileSync(`${t.repo.gitdir}/logs/refs/remotes/origin/main`, 'utf8')).toContain('update by push');
    await expect(updateRef(t.repo, t.repo.gitdir, 'refs/remotes/origin/main', base, c, 'x', 0)).rejects.toMatchObject({ kind: 'RefMoved' });
    await setHead(t.repo, t.repo.gitdir, { detached: base });
    expect(t.memfs.readFileSync(`${t.repo.gitdir}/HEAD`, 'utf8')).toBe(`${base}\n`);
    await setHead(t.repo, t.repo.gitdir, { branch: 'refs/heads/main' });
    expect(t.memfs.readFileSync(`${t.repo.gitdir}/HEAD`, 'utf8')).toBe('ref: refs/heads/main\n');
  });

  it('a picked commit keeps its author as stored, zone and all; a Signature is minutes east', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    const base = await t.commit('Base');
    const { ctx } = await openForWrite(t);
    const tree = (await readCommit(t.repo, base)).tree;
    const theirs = await writeCommitObject(t.repo, { tree, parents: [base], message: 'Theirs\n', author: { name: 'Ada Lovelace', email: 'ada@example.com', timestamp: 1_790_000_000, timezoneOffset: 60 } }, ctx);
    expect(await rawAuthor(t.repo, theirs)).toBe('Ada Lovelace <ada@example.com> 1790000000 +0100');
    const picked = await writeCommitObject(t.repo, { tree, parents: [theirs], message: 'Theirs\n', author: await rawAuthor(t.repo, theirs) }, ctx);
    expect(await rawAuthor(t.repo, picked)).toBe('Ada Lovelace <ada@example.com> 1790000000 +0100');
  });

  it('merges trees with stages for a conflict', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    const base = await t.commit('Base');
    await t.branch('side');
    await t.write('a.txt', 'main\n');
    const ours = await t.commit('Main');
    await t.checkout('side');
    await t.write('a.txt', 'side\n');
    const theirs = await t.commit('Side');
    const tree = async (c: string) => (await readCommit(t.repo, c)).tree;
    const r = await mergeTrees(t.repo, { base: await tree(base), ours: await tree(ours), theirs: await tree(theirs), labels: { ours: 'HEAD', theirs: 'side', base: 'base' } });
    expect(r.tree).toBeNull();
    expect(r.conflicts).toEqual(['a.txt']);
    expect(r.index.filter((e) => e.path === 'a.txt').map((e) => e.stage)).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(r.files.get('a.txt')!.bytes)).toContain('<<<<<<< HEAD\nmain\n=======\nside\n>>>>>>> side\n');
  });

  it("runs this plan's intent through phase 3's pipeline, with its views", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    const head = await t.commit('Base');
    const { ctx, id, wt } = await openForWrite(t);
    const intent: WriteIntent<string> = {
      kind: 'branch', label: () => 'look', undo: null,
      run: async (cx) => `${cx.op > 0}:${cx.root}:${cx.before.head.branch}:${cx.before.head.oid === head}`,
    };
    const done = await runWrite(ctx, id, wt, NO_EXPECT, intent);
    expect(done.outcome).toBe(`true:${t.dir}:main:true`);
    expect(ctx.events.map((e) => e.type)).toEqual(expect.arrayContaining(['opStarted', 'opFinished']));
    expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
  });

  it("carries an interactive rebase's pause into the journal, and a queued op leaves on Cancel", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    const head = await t.commit('Base');
    const { ctx, id, wt } = await openForWrite(t);
    const stop: WriteIntent<null> = {
      kind: 'rebase', label: () => 'rebase main', undo: 'rewind',
      run: async (cx) => {
        t.memfs.mkdirpSync(`${cx.gitdir}/rebase-merge`);
        cx.paused = { kind: 'rebase', target: 'main', targetOid: head, picked: [], irebase: true };
        expect(cx.paused).toEqual({ kind: 'rebase', target: 'main', targetOid: head, picked: [], irebase: true });
        return null;
      },
    };
    expect((await runWrite(ctx, id, wt, NO_EXPECT, stop)).journal.paused).toMatchObject({ kind: 'rebase', irebase: true });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const atStop = runWrite(ctx, id, wt, NO_EXPECT, { kind: 'commit', label: () => 'commit at the stop', undo: null, allowedInProgress: true, run: async (cx) => (await gate, notePaused(cx, (s) => s.made.push(head)), null) });
    const fetch = beginOp(ctx);
    const queued = withQueueSlot(ctx, id, 'fetch', 'fetch', fetch.id, async () => 'fetched');
    await new Promise((r) => setTimeout(r, 0));
    let told = false;
    fetch.onCancel(() => (told = true));
    ctx.writes.cancel(fetch.id);
    await expect(queued).rejects.toMatchObject({ kind: 'Cancelled' });
    open();
    await atStop;
    expect([told, fetch.cancelled(), ctx.writes.journal(wt).paused()?.paused?.irebase]).toEqual([true, false, { made: [head], moved: [] }]);
    // Cancelled before it joins the queue: it leaves at once, and never runs.
    const early = beginOp(ctx);
    ctx.writes.cancel(early.id);
    let ran = false;
    await expect(withQueueSlot(ctx, id, 'fetch', 'fetch', early.id, async () => (ran = true))).rejects.toMatchObject({ kind: 'Cancelled', message: 'Cancelled' });
    expect([ran, ctx.writes.queue(id, ctx.emit).state()]).toEqual([false, { running: null, queued: [], stopped: null }]);
  });
});
