import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { readCommit } from '../read/commitText';
import { makeTestRepo, GRACE, type TestRepo } from '../read/testkit';
import { readInProgress, readRef, runWrite, NO_EXPECT, type UndoKind, type WriteCx, type WriteIntent } from '../writeSeam';
import { openForWrite } from '../writeSeamTest';
import { abortSeq, COMMIT_OR_DISCARD, continueSeq, EMPTY_PICK, notStaged, revertMessage, skipSeq, startSeq, type SeqEnd, type SeqStart } from './engine';
import { rebaseLab, stackShape, subjects } from './fixtures';
import { readSeq, type Step } from './state';

type Ctx = Awaited<ReturnType<typeof openForWrite>>['ctx'];

/** Runs `f` inside a write of `t`'s main worktree, as the intents do; `pause` sets the write's
 *  pause on a stop, as the interactive rebase's intent does (its entry then waits). */
async function inWrite<T>(t: TestRepo, f: (cx: WriteCx) => Promise<T>, o: { ctx?: Ctx; undo?: UndoKind | null; pause?: boolean } = {}): Promise<T> {
  const { ctx: fresh, id, wt } = await openForWrite(t);
  const ctx = o.ctx ?? fresh;
  const intent: WriteIntent<T> = {
    kind: 'rebase', label: () => 'test', undo: o.undo ?? null, allowedInProgress: true,
    run: async (cx) => {
      const out = await f(cx);
      const end = out as SeqEnd;
      if (o.pause && end.status === 'stopped') cx.paused = { kind: 'rebase', target: 'main', targetOid: await t.rev('main'), picked: [], irebase: true };
      return out;
    },
  };
  const r = await runWrite(ctx, id, wt, NO_EXPECT, intent);
  if (r.outcome === undefined || r.outcome === null) throw new Error(JSON.stringify(r));
  return r.outcome;
}

/** `<ref>~<n>` (isomorphic-git resolves no `~`). */
async function back(t: TestRepo, ref: string, n: number): Promise<string> {
  let at = await t.rev(ref);
  for (let i = 0; i < n; i++) at = (await readCommit(t.repo, at)).parents[0];
  return at;
}
const parentOf = (t: TestRepo, ref: string) => back(t, ref, 1);

const pick = (oid: string): Step => ({ op: 'pick', oid, parent: null });

async function linear(t: TestRepo, onto: string, rows: string[], over: Partial<SeqStart> = {}, o: { ctx?: Ctx; undo?: UndoKind | null; pause?: boolean } = {}): Promise<SeqEnd> {
  const origHead = await t.rev('HEAD');
  const ontoOid = onto.length === 40 ? onto : await t.rev(onto);
  return inWrite(t, (cx) => startSeq(cx, {
    kind: 'rebase', headName: 'refs/heads/lab', origHead, onto: ontoOid, target: onto, interactive: false,
    steps: rows.map(pick), range: rows, refsBefore: {}, deletes: {}, empty: 'drop', ...over,
  }), o);
}

/** lab's six commits, oldest first. */
async function labRows(t: TestRepo): Promise<string[]> {
  const rows: string[] = [];
  for (let at = await t.rev('lab'), base = await parentOf(t, 'main'); at !== base; at = (await readCommit(t.repo, at)).parents[0]) rows.unshift(at);
  return rows;
}

const read = (t: TestRepo, path: string) => t.memfs.promises.readFile(`${t.dir}/${path}`, 'utf8');
const headFile = async (t: TestRepo) => String(await t.memfs.promises.readFile(`${t.repo.gitdir}/HEAD`, 'utf8'));

describe('the step runner', () => {
  it('replays a clean range onto the target and moves the branch', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = (await labRows(t)).filter((_, i) => i !== 1); // without L2, which conflicts
    const end = await linear(t, 'main', rows);
    expect(end.status).toBe('done');
    expect(await subjects(t, 'main', 'lab')).toEqual(['L1 Add parser', 'L3 Append four', 'L4 Refine four', 'L5 Add tests', 'L6 Add docs']);
    expect(await headFile(t)).toBe('ref: refs/heads/lab\n');
    const l1 = await readCommit(t.repo, await back(t, 'lab', 4));
    expect(l1.summary).toBe('L1 Add parser');
    expect(l1.author.name).toBe('Ada Lovelace');
    expect(l1.committer).toMatchObject({ name: 'You', email: 'you@example.com' });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
  });

  it('stops on a conflict, then continues with the resolution and a new message', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const end = await linear(t, 'main', rows, { interactive: true });
    // Stop.conflicts lists the paths (git's `# Conflicts:` block); the message stays raw.
    expect(end).toMatchObject({ status: 'stopped', stop: { reason: 'conflict', at: rows[1], message: 'L2 Reword line two\n', conflicts: ['notes.txt'] }, files: 1 });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ kind: 'rebase', stoppedAt: rows[1], conflicted: 1, step: 2, total: 6, gitvolt: true });
    // Continue before resolving: the stop stands (the core reports it stopped again).
    expect(await inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'))).toMatchObject({ status: 'stopped', files: 1 });
    await t.write('notes.txt', 'one\ntwo, both\nthree\n');
    await t.stage('notes.txt');
    // git's strip cleanup: `#` lines and trailing blanks go.
    const done = await inWrite(t, (cx) => continueSeq(cx, 'L2 Merge both edits\n#123 gone\n\n', 'rebase'));
    expect(done.status).toBe('done');
    expect(await subjects(t, 'main', 'lab')).toEqual(['L1 Add parser', 'L2 Merge both edits', 'L3 Append four', 'L4 Refine four', 'L5 Add tests', 'L6 Add docs']);
    expect((await readCommit(t.repo, await t.rev('lab'))).author.name).toBe('Ada Lovelace');
    expect((await readCommit(t.repo, await back(t, 'lab', 4))).rawMessage).toBe('L2 Merge both edits\n');
    expect(await read(t, 'notes.txt')).toBe('one\ntwo, both\nthree\nfour, refined\n');
  });

  it('skips the stopped commit', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    await linear(t, 'main', rows);
    const end = await inWrite(t, (cx) => skipSeq(cx, 'rebase'));
    expect(end.status).toBe('done');
    expect(await subjects(t, 'main', 'lab')).toEqual(['L1 Add parser', 'L3 Append four', 'L4 Refine four', 'L5 Add tests', 'L6 Add docs']);
    expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
  });

  it('abort restores the branch, HEAD and the worktree', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const before = await t.rev('lab');
    await linear(t, 'main', await labRows(t));
    const r = await inWrite(t, (cx) => abortSeq(cx, 'rebase'));
    expect(r).toEqual({ stash: null, branch: null });
    expect(await t.rev('lab')).toBe(before);
    expect(await headFile(t)).toBe('ref: refs/heads/lab\n');
    expect(await read(t, 'notes.txt')).toBe('one\ntwo, lab\nthree\nfour, refined\n');
    expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
  });

  it("marks what the core's git run changes, and reloads the graph once when a step ran and HEAD moved", async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = (await labRows(t)).slice(0, 2); // L2, the last row, conflicts
    const { ctx } = await openForWrite(t);
    const write = () => {
      const from = ctx.events.length;
      return () => ctx.events.slice(from);
    };
    let events = write();
    await linear(t, 'main', rows, {}, { ctx });
    // `run_rebase_stop`: everything but config and stashes; its last progress tick saw HEAD move.
    expect(events().find((e) => e.type === 'repoChanged')).toMatchObject({ kinds: ['worktree', 'index', 'refs', 'head', 'state'] });
    expect(events().filter((e) => e.type === 'refsUpdated')).toHaveLength(1);
    await t.write('notes.txt', 'one\ntwo, both\nthree\n');
    await t.stage('notes.txt');
    events = write();
    expect((await inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'), { ctx })).status).toBe('done');
    // No step left to start: git prints none. The branch git moves at the finish isn't the write's
    // own move either: preflight saw a detached HEAD (the core's verify, write/mod.rs step 7).
    expect(events().filter((e) => e.type === 'refsUpdated')).toHaveLength(0);
    expect(await headFile(t)).toBe('ref: refs/heads/lab\n');
  });

  it('abort after a fold conflict restores the branch', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const before = await t.rev('lab');
    // L3 applies cleanly on main; L2 folded into it then edits the line main edited.
    const steps: Step[] = [pick(rows[0]), pick(rows[2]), { op: 'fold', oid: rows[1], fixup: false }];
    const end = await inWrite(t, async (cx) => startSeq(cx, { kind: 'rebase', headName: 'refs/heads/lab', origHead: before, onto: await t.rev('main'), target: 'main', interactive: true, steps, range: rows, refsBefore: {}, deletes: {}, empty: 'drop' }));
    expect(end).toMatchObject({ status: 'stopped', stop: { reason: 'conflict', at: rows[1] } });
    expect((end as { stop: object }).stop).not.toHaveProperty('conflicts');
    // The fold's stop leaves HEAD on the commit it amends: the state's head is HEAD (git's `amend`).
    const head = (await headFile(t)).trim();
    expect((await readSeq(t.repo, t.repo.gitdir))!.head).toBe(head);
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ editStop: head, step: 3, total: 3 });
    await inWrite(t, (cx) => abortSeq(cx, 'rebase'));
    expect(await t.rev('lab')).toBe(before);
    expect(await headFile(t)).toBe('ref: refs/heads/lab\n');
    expect(await read(t, 'notes.txt')).toBe('one\ntwo, lab\nthree\nfour, refined\n');
  });

  it('a pick whose base is its own parent keeps its id', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const end = await linear(t, await parentOf(t, 'main'), rows.slice(0, 1));
    expect(end).toMatchObject({ status: 'done', head: rows[0] });
  });

  it('squash and fixup fold into the row below with the merged message', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const [a, b, c] = [await t.rev('feature/a'), await t.rev('feature/b'), await t.rev('feature/c')];
    const end = await inWrite(t, async (cx) => startSeq(cx, {
      kind: 'rebase', headName: 'refs/heads/feature/c', origHead: c, onto: await t.rev('main'), target: 'main', interactive: true,
      steps: [pick(a), { op: 'fold', oid: b, fixup: false }, { op: 'fold', oid: c, fixup: true }], range: [a, b, c], refsBefore: {}, deletes: {}, empty: 'drop',
    }));
    expect(end.status).toBe('done');
    const tip = await readCommit(t.repo, await t.rev('feature/c'));
    expect(tip.message).toBe('Work on feature/a\n\nWork on feature/b');
    expect(tip.parents).toEqual([await t.rev('main')]);
  });

  it('update-ref steps move the stacked branches at the end', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const [a, b, c] = [await t.rev('feature/a'), await t.rev('feature/b'), await t.rev('feature/c')];
    const end = await inWrite(t, async (cx) => startSeq(cx, {
      kind: 'rebase', headName: 'refs/heads/feature/c', origHead: c, onto: await t.rev('main'), target: 'main', interactive: false,
      steps: [pick(a), { op: 'updateRef', ref: 'refs/heads/feature/a' }, pick(b), { op: 'updateRef', ref: 'refs/heads/feature/b' }, pick(c)],
      range: [a, b, c], refsBefore: { 'refs/heads/feature/a': a, 'refs/heads/feature/b': b }, deletes: {}, empty: 'drop',
    }));
    expect(end.status).toBe('done');
    expect(await subjects(t, 'main', 'feature/a')).toEqual(['Work on feature/a']);
    expect(await subjects(t, 'main', 'feature/b')).toEqual(['Work on feature/a', 'Work on feature/b']);
    expect(await git.resolveRef({ fs: t.memfs, dir: t.dir, ref: 'feature/c' })).not.toBe(c);
  });

  it('counts every todo line, as git: an exec or update-ref line is a step', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const steps: Step[] = [pick(rows[0]), { op: 'line', text: 'exec sh 1.sh' }, { op: 'updateRef', ref: 'refs/heads/chip' }, pick(rows[1]), pick(rows[2])];
    const end = await linear(t, 'main', rows, { steps });
    expect(end.status).toBe('stopped');
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ step: 4, total: 5 });
  });

  it('keeps a commit that started empty, drops one that became empty, or stops on it', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    await t.branch('lab');
    await t.write('m.txt', 'm\n');
    await t.commit('Main adds m');
    await t.checkout('lab');
    const startedEmpty = await t.commit('Empty from the start');
    await t.write('m.txt', 'm\n');
    const becomes = await t.commit('Adds m too');
    const rows = [startedEmpty, becomes];
    expect(await linear(t, 'main', rows)).toMatchObject({ status: 'done' });
    expect(await subjects(t, 'main', 'lab')).toEqual(['Empty from the start']);

    const u = await makeTestRepo();
    await u.write('a.txt', 'a\n');
    await u.commit('Base');
    await u.branch('lab');
    await u.write('m.txt', 'm\n');
    await u.commit('Main adds m');
    await u.checkout('lab');
    await u.write('m.txt', 'm\n');
    const again = await u.commit('Adds m too');
    expect(await linear(u, 'main', [again], { empty: 'stop' })).toMatchObject({ status: 'stopped', stop: { reason: 'empty', at: again, error: EMPTY_PICK } });
  });

  it("stops 'about to commit' at an Edit row; Continue with nothing changed keeps the stop's commit", async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const end = await linear(t, 'main', rows.slice(0, 1), { interactive: true, steps: [{ op: 'pick', oid: rows[0], parent: null, edit: true }] });
    expect(end.status).toBe('stopped');
    const stop = (end as Extract<SeqEnd, { status: 'stopped' }>).stop;
    const main = await t.rev('main');
    expect(stop).toMatchObject({ reason: 'edit', at: rows[0], editBase: main, added: ['file_1.txt'], message: 'L1 Add parser\n' });
    expect(stop.madeFiles!.map(([p]) => p)).toEqual(['file_1.txt', 'notes.txt']);
    expect((await headFile(t)).trim()).toBe(main);
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ editStop: stop.made, editBase: main, editChanged: false, editAdded: ['file_1.txt'] });
    const done = await inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'));
    expect(done).toMatchObject({ status: 'done', head: stop.made });
  });

  it("a Continue refused at an Edit stop marks only the write's own worktree and index (irebase/edit.rs refuses before git)", async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const steps: Step[] = [{ op: 'pick', oid: rows[0], parent: null, edit: true }];
    await linear(t, await parentOf(t, 'main'), rows.slice(0, 1), { interactive: true, steps });
    await t.write('notes.txt', 'one\ntwo\nthree\nextra\n');
    const { ctx } = await openForWrite(t);
    await expect(inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'), { ctx })).rejects.toMatchObject({ message: COMMIT_OR_DISCARD });
    expect(ctx.events.filter((e) => e.type === 'repoChanged').at(-1)).toMatchObject({ kinds: ['worktree', 'index'] });
  });

  it('an Edit row on an unchanged base keeps its id; a staged change commits as the original author', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const base = await parentOf(t, 'main');
    const steps: Step[] = [{ op: 'pick', oid: rows[0], parent: null, edit: true }, { op: 'pick', oid: rows[1], parent: null, edit: true }];
    const first = await linear(t, base, rows.slice(0, 2), { interactive: true, steps });
    expect(first).toMatchObject({ status: 'stopped', stop: { reason: 'edit', made: rows[0], editBase: base } });
    // Every Edit stop carries the made commit's files.
    expect((first as Extract<SeqEnd, { status: 'stopped' }>).stop.madeFiles).toBeDefined();
    await t.write('notes.txt', 'one\ntwo\nthree\nextra\n');
    await expect(inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'))).rejects.toMatchObject({ kind: 'InvalidInput', message: COMMIT_OR_DISCARD });
    await t.stage('notes.txt');
    const second = await inWrite(t, (cx) => continueSeq(cx, 'L1, extended\n', 'rebase'));
    expect(second).toMatchObject({ status: 'stopped', stop: { reason: 'edit', at: rows[1] } });
    expect((second as Extract<SeqEnd, { status: 'stopped' }>).stop.madeFiles).toBeDefined();
    const made = (second as Extract<SeqEnd, { status: 'stopped' }>).stop.editBase!;
    const c = await readCommit(t.repo, made);
    expect([c.summary, c.author.name, c.committer.name]).toEqual(['L1, extended', 'Ada Lovelace', 'You']);
    expect(c.parents).toEqual([base]);
  });

  it("a Continue at an Edit stop notes its commit on the paused session; the finish records the chips' moves there", async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const [a, b, c] = [await t.rev('feature/a'), await t.rev('feature/b'), await t.rev('feature/c')];
    await git.branch({ fs: t.memfs, dir: t.dir, ref: 'gone', object: a });
    const { ctx } = await openForWrite(t);
    const end = await inWrite(t, async (cx) => startSeq(cx, {
      kind: 'rebase', headName: 'refs/heads/feature/c', origHead: c, onto: await t.rev('main'), target: 'main', interactive: true,
      steps: [{ op: 'pick', oid: a, parent: null, edit: true }, { op: 'updateRef', ref: 'refs/heads/feature/a' }, { op: 'pick', oid: b, parent: null, edit: true }, pick(c)],
      range: [a, b, c], refsBefore: { 'refs/heads/feature/a': a }, deletes: { 'refs/heads/gone': a }, empty: 'drop',
    }), { ctx, undo: 'rewind', pause: true });
    expect(end.status).toBe('stopped');
    await t.write('more.txt', 'more\n');
    await t.stage('more.txt');
    const next = await inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'), { ctx, undo: null });
    expect(next).toMatchObject({ status: 'stopped', stop: { reason: 'edit', at: b } });
    const made = (next as Extract<SeqEnd, { status: 'stopped' }>).stop.editBase!;
    expect(ctx.writes.journal(t.dir).paused()?.paused?.irebase?.made).toEqual([made]);
    const done = await inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'), { ctx, undo: null });
    expect(done.status).toBe('done');
    const entry = ctx.writes.journal(t.dir).undo.find((e) => e.label === 'test')!;
    const newA = await t.rev('feature/a');
    expect(entry.refs).toEqual(expect.arrayContaining([
      { name: 'refs/heads/feature/a', old: a, new: newA },
      { name: 'refs/heads/gone', old: a, new: null },
    ]));
    expect(readRef(t.repo.demo!, 'refs/heads/gone')).toBeNull();
    expect((await readCommit(t.repo, newA)).author.email).toBe('ada@example.com');
  });

  it("an Edit row's new message is its stop's: the stop's commit keeps the original, Continue commits the new one", async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const end = await linear(t, 'main', rows.slice(0, 1), { interactive: true, steps: [{ op: 'pick', oid: rows[0], parent: null, edit: true, message: 'L1, renamed\n' }] });
    const stop = (end as Extract<SeqEnd, { status: 'stopped' }>).stop;
    expect(stop.message).toBe('L1, renamed\n');
    expect((await readCommit(t.repo, stop.made!)).rawMessage).toBe('L1 Add parser\n');
    const done = await inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'));
    expect(done.status).toBe('done');
    const tip = await readCommit(t.repo, await t.rev('lab'));
    expect([tip.rawMessage, tip.parents[0], tip.author.name]).toEqual(['L1, renamed\n', await t.rev('main'), 'Ada Lovelace']);
  });

  it("abort at an Edit stop keeps the stop's edits as a stash, untracked files left in place", async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const before = await t.rev('lab');
    const { ctx } = await openForWrite(t);
    await linear(t, 'main', rows.slice(0, 1), { interactive: true, steps: [{ op: 'pick', oid: rows[0], parent: null, edit: true }] }, { ctx, undo: 'rewind', pause: true });
    await t.write('file_1.txt', 'changed at the stop\n');
    await t.stage('file_1.txt');
    await t.write('scratch.txt', 'mine\n');
    const r = await inWrite(t, (cx) => abortSeq(cx, 'rebase'), { ctx });
    expect(r.branch).toBeNull();
    // The core's keep_edits: its plain message, HEAD's tree with only the new content, its banner.
    const stash = await readCommit(t.repo, r.stash!);
    expect(stash.summary).toBe('GitVolt: work from the aborted rebase of lab');
    expect((await readCommit(t.repo, stash.parents[1])).summary).toBe('index on lab');
    expect(ctx.writes.journal(t.dir).state(null).banners).toMatchObject([{ kind: 'abortedWork', stash: r.stash, stashMessage: 'GitVolt: work from the aborted rebase of lab', label: 'abort the rebase of lab', target: null, canDrop: false }]);
    expect(await t.rev('lab')).toBe(before);
    expect(await headFile(t)).toBe('ref: refs/heads/lab\n');
    expect(await read(t, 'scratch.txt')).toBe('mine\n');
    expect(await read(t, 'file_1.txt')).toBe('L1 Add parser\n');
  });

  it('a cherry-pick moves the branch at each commit, keeping each author and the message without its leading blank lines', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    await t.branch('side');
    await t.checkout('side');
    await t.write('b.txt', 'b\n');
    const b = await t.commit('\n  Pick line  \nmore\n', GRACE);
    await t.checkout('main');
    const old = await t.rev('main');
    const end = await inWrite(t, (cx) => startSeq(cx, { kind: 'cherryPick', headName: 'refs/heads/main', origHead: old, onto: old, target: 'b', interactive: false, steps: [pick(b)], range: [b], refsBefore: {}, deletes: {}, empty: 'stop' }));
    expect(end.status).toBe('done');
    const c = await readCommit(t.repo, await t.rev('main'));
    expect([c.rawMessage, c.author.name, c.committer.name, c.parents[0]]).toEqual(['  Pick line  \nmore\n', 'Grace Hopper', 'You', old]);
    expect(await headFile(t)).toBe('ref: refs/heads/main\n');
  });

  it('a revert says what it reverts; a revert of a revert reapplies it', () => {
    const oid = 'a'.repeat(40);
    expect(revertMessage(oid, 'Add two')).toBe(`Revert "Add two"\n\nThis reverts commit ${oid}.\n`);
    expect(revertMessage(oid, 'Revert "Add two"')).toBe(`Reapply "Add two"\n\nThis reverts commit ${oid}.\n`);
    expect(revertMessage(oid, 'Reapply "Add two"')).toBe(`Revert "Reapply "Add two""\n\nThis reverts commit ${oid}.\n`);
    expect(revertMessage(oid, 'Revert "X" extra')).toBe(`Reapply "X" extra\n\nThis reverts commit ${oid}.\n`);
    expect(revertMessage(oid, '  Revert "X"')).toBe(`Revert "  Revert "X""\n\nThis reverts commit ${oid}.\n`);
    // A revert of a revert of a revert says Revert again (the binary).
    expect(revertMessage(oid, 'Revert "Revert "X""')).toBe(`Revert "Revert "Revert "X"""\n\nThis reverts commit ${oid}.\n`);
    expect(revertMessage(oid, 'Revert "Revert X"')).toBe(`Reapply "Revert X"\n\nThis reverts commit ${oid}.\n`);
    expect(revertMessage(oid, 'Revert "Revert "')).toBe(`Revert "Revert "Revert ""\n\nThis reverts commit ${oid}.\n`);
  });

  it("a revert's subject is the first non-blank line as stored; an empty revert fails", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    await t.write('x.txt', 'x\n');
    const x = await t.commit('\n\n  First line  \nsecond line\n\nBody\n');
    const old = await t.rev('main');
    const revert = (from: string): SeqStart => ({ kind: 'revert', headName: 'refs/heads/main', origHead: from, onto: from, target: 'x', interactive: false, steps: [pick(x)], range: [x], refsBefore: {}, deletes: {}, empty: 'stop' });
    expect((await inWrite(t, (cx) => startSeq(cx, revert(old)))).status).toBe('done');
    const r = await readCommit(t.repo, await t.rev('main'));
    expect([r.rawMessage, r.author.name]).toEqual([`Revert "  First line  "\n\nThis reverts commit ${x}.\n`, 'You']);
    const now = await t.rev('main');
    await expect(inWrite(t, (cx) => startSeq(cx, revert(now)))).rejects.toMatchObject({ message: 'git exited with status 1' });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
    expect(await t.rev('main')).toBe(now);
  });
  it('a refused cherry-pick quits the sequence, saying how far it got; a single one says only why', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    await t.branch('side');
    await t.checkout('side');
    await t.write('o.txt', 'o\n');
    const o = await t.commit('Add o');
    await t.write('n.txt', 'n\n');
    const n = await t.commit('Add n');
    await t.checkout('main');
    await t.write('n.txt', 'mine\n');
    const old = await t.rev('main');
    const picks = (oids: string[], from: string): SeqStart => ({ kind: 'cherryPick', headName: 'refs/heads/main', origHead: from, onto: from, target: 'x', interactive: false, steps: oids.map(pick), range: oids, refsBefore: {}, deletes: {}, empty: 'stop' });
    const words = 'The following untracked working tree files would be overwritten by merge:';
    await expect(inWrite(t, (cx) => startSeq(cx, picks([o, n], old)))).rejects.toMatchObject({ message: `${words} (1 of 2 applied, the rest weren't)` });
    expect(await readSeq(t.repo, t.repo.gitdir)).toBeNull();
    expect(await subjects(t, old, 'main')).toEqual(['Add o']);
    const now = await t.rev('main');
    await expect(inWrite(t, (cx) => startSeq(cx, picks([n], now)))).rejects.toMatchObject({ message: words });
    expect(await readSeq(t.repo, t.repo.gitdir)).toBeNull();
    expect(await read(t, 'n.txt')).toBe('mine\n');
  });

  it("a rebase's refused pick is rescheduled: a stop, and its retry counts as git's", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    await t.commit('Base');
    await t.branch('lab');
    await t.write('a.txt', 'one, main\n');
    await t.commit('Main');
    await t.checkout('lab');
    await t.write('n.txt', 'n\n');
    const addN = await t.commit('Add n');
    await t.remove('n.txt');
    const removeN = await t.commit('Remove n');
    await t.write('a.txt', 'one, lab\n');
    const editA = await t.commit('Edit a');
    await t.write('n.txt', 'mine\n');
    const end = await linear(t, 'main', [addN, removeN, editA]);
    expect(end).toMatchObject({ status: 'stopped', files: 0, stop: { reason: 'refused', at: addN, error: 'The following untracked working tree files would be overwritten by merge:' } });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ stoppedAt: addN, step: 1, total: 3 });
    await t.remove('n.txt');
    const next = await inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'));
    expect(next).toMatchObject({ status: 'stopped', stop: { reason: 'conflict', at: editA } });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ step: 4, total: 4 });
  });

  it('a chip that moved during a stop: the branch moves, the finish stops on it as git does, and Abort puts the branch back', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const [a, b, c] = [await t.rev('feature/a'), await t.rev('feature/b'), await t.rev('feature/c')];
    const main = await t.rev('main');
    await linear(t, 'main', [a, b, c], {
      headName: 'refs/heads/feature/c', origHead: c, interactive: true, refsBefore: { 'refs/heads/feature/a': a },
      steps: [{ op: 'pick', oid: a, parent: null, edit: true }, { op: 'updateRef', ref: 'refs/heads/feature/a' }, pick(b), pick(c)],
    });
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/feature/a', value: main, force: true });
    const end = await inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'));
    const error = `update_ref failed for ref 'refs/heads/feature/a': cannot lock ref 'refs/heads/feature/a': is at ${main} but expected ${a}`;
    expect(end).toMatchObject({ status: 'stopped', files: 0, stop: { reason: 'refused', error } });
    expect(await t.rev('feature/c')).not.toBe(c);
    expect(await headFile(t)).toBe('ref: refs/heads/feature/c\n');
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ kind: 'rebase', stoppedAt: null, step: 4, total: 4 });
    await inWrite(t, (cx) => abortSeq(cx, 'rebase'));
    expect(await t.rev('feature/c')).toBe(c);
    expect(await t.rev('feature/a')).toBe(main);
    expect(await headFile(t)).toBe('ref: refs/heads/feature/c\n');
  });

  it("an Edit stop names a commit's file left untracked; Abort's work branch takes the next free name", async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/lab-rebase-work/old', value: rows[0] });
    const { ctx } = await openForWrite(t);
    await linear(t, 'main', rows.slice(0, 1), { interactive: true, steps: [{ op: 'pick', oid: rows[0], parent: null, edit: true }] }, { ctx, undo: 'rewind', pause: true });
    await git.remove({ fs: t.memfs, dir: t.dir, filepath: 'file_1.txt' });
    await expect(inWrite(t, (cx) => continueSeq(cx, undefined, 'rebase'))).rejects.toMatchObject({ kind: 'InvalidInput', message: notStaged('file_1.txt') });
    await t.stage('file_1.txt');
    // A commit made at the stop (HEAD off the stop's base).
    const at = await git.commit({ fs: t.memfs, dir: t.dir, message: 'Made at the stop\n', author: { name: 'You', email: 'you@example.com', timestamp: 1_800_000_000, timezoneOffset: 0 } });
    const r = await inWrite(t, (cx) => abortSeq(cx, 'rebase'), { ctx });
    expect(r.branch).toBe('lab-rebase-work-2');
    expect(await t.rev('lab-rebase-work-2')).toBe(at);
  });

  it('Continue, Skip and Abort name the operation they expect', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    await expect(inWrite(t, (cx) => skipSeq(cx, 'rebase'))).rejects.toMatchObject({ kind: 'InvalidInput', message: 'No rebase is in progress' });
    await linear(t, 'main', await labRows(t));
    await expect(inWrite(t, (cx) => continueSeq(cx, undefined, 'pick'))).rejects.toMatchObject({ kind: 'InvalidInput', message: 'No cherry-pick or revert is in progress' });
  });

  it("a Cancel of a rebase it started aborts it, as the core's does; one of a Continue leaves it paused", async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = (await labRows(t)).filter((_, i) => i !== 1);
    const lab = await t.rev('lab');
    const start = (cx: WriteCx) => {
      cx.ctx.writes.cancel(cx.op);
      return startSeq(cx, { kind: 'rebase', headName: 'refs/heads/lab', origHead: lab, onto: lab, target: 'main', interactive: false, steps: rows.map(pick), range: rows, refsBefore: {}, deletes: {}, empty: 'drop' });
    };
    await expect(inWrite(t, start)).rejects.toMatchObject({ kind: 'Cancelled', message: 'Cancelled' });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
    expect(await t.rev('lab')).toBe(lab);
    expect(await headFile(t)).toBe('ref: refs/heads/lab\n');

    // A Continue (the conflict at L2 resolved) cancelled before its next step stays paused.
    const conflict = (await labRows(t)).slice(1, 3); // L2 conflicts, L3 is still to do
    expect((await linear(t, 'main', conflict)).status).toBe('stopped');
    await t.write('notes.txt', 'resolved\n');
    await t.stage('notes.txt');
    await expect(inWrite(t, (cx) => { cx.ctx.writes.cancel(cx.op); return continueSeq(cx, undefined, 'rebase'); })).rejects.toMatchObject({ kind: 'Cancelled' });
    expect(readInProgress(t.memfs, t.repo.gitdir)).toMatchObject({ kind: 'rebase' });
  });

  it('a 60-commit rebase runs in under two seconds', async () => {
    const t = await makeTestRepo();
    await t.write('base.txt', 'base\n');
    await t.commit('Base');
    await t.branch('topic');
    await t.checkout('topic');
    const rows: string[] = [];
    for (let i = 0; i < 60; i++) {
      await t.write(`topic/${String(i).padStart(2, '0')}.txt`, `${i}\n`);
      rows.push(await t.commit(`Topic ${i}`));
    }
    await t.checkout('main');
    await t.write('upstream.txt', 'upstream\n');
    await t.commit('Upstream');
    await t.checkout('topic');
    const started = performance.now();
    const end = await linear(t, 'main', rows, { headName: 'refs/heads/topic' });
    expect(end.status).toBe('done');
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
