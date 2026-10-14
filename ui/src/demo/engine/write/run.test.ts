import { describe, expect, it } from 'vitest';
import type { AppEvent } from '../../../api/gen/AppEvent';
import type { DemoContext } from '../../context';
import { gbError } from '../errors';
import { fakeCtx, makeTestRepo } from '../read/testkit';
import { readFileState, writeFileState } from './files';
import { entryOfFile, loadIndex, saveIndex, withEntry } from './index';
import { readHead } from './refs';
import { runWrite, type WriteIntent } from './run';
import { mainWt } from './seam';
import { journalHandlers } from '../../handlers/journal';

const NO = { head: null, refs: {} };
const enc = (s: string) => new TextEncoder().encode(s);

async function setup() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  const base = await t.commit('Base');
  await t.write('a.txt', 'a2\n');
  const two = await t.commit('Two');
  const events: AppEvent[] = [];
  const ctx: DemoContext = { ...fakeCtx(t.repo), emit: (ev: AppEvent) => void events.push(ev) };
  return { t, base, two, ctx, events };
}

/** A test intent: `main` (HEAD's branch) from `from` to `to`, journaled as MoveRefs. */
const moveMain = (from: string, to: string, extra: Partial<WriteIntent<string>> = {}): WriteIntent<string> => ({
  kind: 'branch',
  label: () => 'move main',
  undo: () => 'moveRefs',
  run: async (cx) => {
    cx.cas([{ name: 'refs/heads/main', old: from, new: to }]);
    return 'moved';
  },
  ...extra,
});

describe('runWrite', () => {
  it('journals what moved, announces it, and replies with the fresh lists', async () => {
    const { t, base, two, ctx, events } = await setup();
    const r = await runWrite(ctx, 1, t.dir, NO, moveMain(two, base));
    expect(r.outcome).toBe('moved');
    expect(r.journal.undo).toEqual({ entry: 1, label: 'move main', kind: 'branch' });
    expect(r.staging).toEqual({ undo: null, redo: null, off: null });
    expect(r.wip?.worktree).toBe(t.dir);
    expect(r.wip?.unstaged.version).toBe(r.wip?.version);
    expect(r.wip?.staged.files.map((f) => f.path)).toEqual(['a.txt']); // HEAD is back at "a"; the index and the file still hold "a2"
    expect(events.map((e) => e.type)).toEqual(['queueChanged', 'queueChanged', 'opStarted', 'queueChanged', 'repoChanged', 'refsUpdated', 'journalChanged', 'opFinished']);
    const changed = events.find((e) => e.type === 'repoChanged');
    expect(changed).toEqual({ type: 'repoChanged', repo: 1, kinds: ['worktree', 'index', 'refs', 'head'], worktrees: [t.dir], versions: { [t.dir]: r.wip?.version } });
    expect(events.at(-1)).toMatchObject({ type: 'opFinished', kind: 'branch', repo: 1, outcome: 'ok', message: null, command: null });
    const e = ctx.writes.journal(t.dir).entry(1)!;
    expect([e.refs, e.headBefore, e.headAfter]).toEqual([[{ name: 'refs/heads/main', old: two, new: base }], { branch: 'main', oid: two }, { branch: 'main', oid: base }]);
    expect(e.treePaths).toEqual(['a.txt']);
  });

  it('drops the entry of a failure that changed nothing, and fails after its events', async () => {
    const { t, ctx, events } = await setup();
    const failing: WriteIntent<null> = { kind: 'commit', label: () => 'commit "x"', undo: () => 'moveRefs', run: async () => { throw gbError('InvalidInput', 'Nothing to commit'); } };
    await expect(runWrite(ctx, 1, t.dir, NO, failing)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Nothing to commit' });
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
    expect(events.map((e) => e.type)).not.toContain('journalChanged');
    expect(events.at(-1)).toMatchObject({ type: 'opFinished', outcome: 'failed', message: 'Nothing to commit' });
  });

  it('refuses what the UI no longer shows, and an operation in progress', async () => {
    const { t, base, two, ctx } = await setup();
    await expect(runWrite(ctx, 1, t.dir, { head: base, refs: {} }, moveMain(two, base))).rejects.toMatchObject({ kind: 'RefMoved', message: 'HEAD changed outside GitVolt' });
    await expect(runWrite(ctx, 1, t.dir, { head: null, refs: { 'refs/heads/main': base } }, moveMain(two, base))).rejects.toMatchObject({ kind: 'RefMoved', message: 'main changed outside GitVolt' });
    t.memfs.writeFileSync(`${t.repo.gitdir}/MERGE_HEAD`, `${base}\n`);
    await expect(runWrite(ctx, 1, t.dir, NO, moveMain(two, base))).rejects.toMatchObject({ kind: 'InProgress', message: 'A merge is in progress' });
    expect((await runWrite(ctx, 1, t.dir, NO, moveMain(two, base, { allowedInProgress: true }))).outcome).toBe('moved');
  });

  it('queued writes run in click order and announce the queue (Review Focus 5)', async () => {
    const { t, base, two, ctx } = await setup();
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const first = runWrite(ctx, 1, t.dir, NO, moveMain(two, base, { label: () => 'first', run: async (cx) => { order.push('first'); await gate; cx.cas([{ name: 'refs/heads/main', old: two, new: base }]); return 'moved'; } }));
    // Sent while the first runs, against the HEAD the UI showed then: carried forward.
    const second = runWrite(ctx, 1, t.dir, { head: two, refs: {} }, { kind: 'commit', label: () => 'second', undo: () => null, run: async (cx) => (order.push('second'), readHead(cx.wt).oid ?? '') });
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.writes.queue(1, ctx.emit).state()).toMatchObject({ running: { label: 'first' }, queued: [{ label: 'second' }] });
    open();
    expect([await first.then((r) => r.outcome), await second.then((r) => r.outcome)]).toEqual(['moved', base]);
    expect(order).toEqual(['first', 'second']);
    await expect(runWrite(ctx, 1, '/demo/nope', NO, moveMain(base, two))).rejects.toMatchObject({ kind: 'InvalidInput' });
    expect(ctx.writes.queue(1, ctx.emit).state()).toEqual({ running: null, queued: [], stopped: null });
  });

  it('a Cancel takes a waiting write out of the queue, and tells a running one once', async () => {
    const { t, base, two, ctx } = await setup();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let told = 0;
    let firstOp = 0;
    const first = runWrite(ctx, 1, t.dir, NO, moveMain(two, base, { run: async (cx) => { firstOp = cx.op; ctx.writes.onCancel(cx.op, () => told++); await gate; return ctx.writes.cancelled(cx.op) ? 'told' : 'not told'; } }));
    const second = runWrite(ctx, 1, t.dir, NO, moveMain(base, two, { label: () => 'second' }));
    await new Promise((r) => setTimeout(r, 0));
    const q = ctx.writes.queue(1, ctx.emit);
    const waiting = q.state().queued[0].op;
    await journalHandlers.cancelOp({ op: waiting }, ctx);
    await expect(second).rejects.toMatchObject({ kind: 'Cancelled', message: 'Cancelled' });
    expect(q.state()).toMatchObject({ queued: [], stopped: null });
    expect([ctx.writes.cancel(firstOp), ctx.writes.cancel(firstOp), told]).toEqual([true, true, 1]);
    open();
    expect((await first).outcome).toBe('told');
    // Finished: nothing left to cancel.
    expect([ctx.writes.cancel(firstOp), ctx.writes.cancelled(firstOp)]).toEqual([false, false]);
    expect(q.state()).toEqual({ running: null, queued: [], stopped: null });
  });

  it('a write that throws past its own steps still finishes its queue item', async () => {
    const { t, base, two, ctx, events } = await setup();
    const broken: WriteIntent<null> = { kind: 'commit', label: () => 'broken', undo: () => { throw new Error('boom'); }, run: async () => null };
    await expect(runWrite(ctx, 1, t.dir, NO, broken)).rejects.toMatchObject({ kind: 'Other', message: 'boom' });
    expect(events.at(-1)).toMatchObject({ type: 'opFinished', outcome: 'failed', message: 'boom' });
    expect(ctx.writes.queue(1, ctx.emit).state()).toEqual({ running: null, queued: [], stopped: null });
    expect((await runWrite(ctx, 1, t.dir, NO, moveMain(two, base))).outcome).toBe('moved');
  });

  it('a throw in the runner leaves no pending entry, and a corrupt index does not fail a step write', async () => {
    const { t, ctx } = await setup();
    t.memfs.writeFileSync(`${t.repo.gitdir}/index`, enc('not an index'));
    const step: WriteIntent<string> = { ...moveMain('x', 'y'), staging: 'step', run: async () => 'ok' };
    expect((await runWrite(ctx, 1, t.dir, NO, step)).outcome).toBe('ok');
    expect(ctx.writes.staging(t.dir).undo).toEqual([]);
    expect(ctx.writes.journal(t.dir).state(null).undo).toBeNull();
    expect(ctx.writes.queue(1, ctx.emit).state()).toEqual({ running: null, queued: [], stopped: null });
    const j = ctx.writes.journal(t.dir);
    j.finalize = () => { throw new Error('late'); };
    const r = await runWrite(ctx, 1, t.dir, NO, { ...moveMain('x', 'y'), run: async () => 'ok' }).catch((e) => e);
    expect(r).toMatchObject({ message: 'late' });
    expect([...j.undo, ...j.redo].filter((e) => e.state === 'pending')).toEqual([]);
  });

  it('a late throw still reports the moves already made', async () => {
    const { t, base, two, ctx, events } = await setup();
    ctx.writes.journal(t.dir).finalize = () => { throw new Error('late'); };
    await expect(runWrite(ctx, 1, t.dir, NO, moveMain(two, base))).rejects.toMatchObject({ message: 'late' });
    expect(events.find((e) => e.type === 'repoChanged')).toMatchObject({ kinds: ['worktree', 'index', 'refs', 'head'] });
    expect(events.map((e) => e.type)).toContain('refsUpdated');
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
  });

  it('a safety-net failure carries its moves to the next queued write and fires journalChanged', async () => {
    const { t, base, two, ctx, events } = await setup();
    const demo = mainWt(t.repo).demo;
    const addCommits = demo.addCommits.bind(demo);
    demo.addCommits = async () => { demo.addCommits = addCommits; throw new Error('late'); }; // after the entry is finalized
    const first = runWrite(ctx, 1, t.dir, NO, moveMain(two, base)).catch((e) => e);
    const second = runWrite(ctx, 1, t.dir, { head: two, refs: {} }, { kind: 'commit', label: () => 'second', undo: () => null, run: async (cx) => readHead(cx.wt).oid ?? '' });
    expect(await first).toMatchObject({ message: 'late' });
    expect(events.map((e) => e.type)).toContain('journalChanged');
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.writes.queue(1, ctx.emit).state().stopped).toMatchObject({ message: 'late' });
    ctx.writes.queue(1, ctx.emit).resume();
    expect((await second).outcome).toBe(base); // HEAD two was carried forward to base
  });

  it('immediate writes skip the queue; step writes are staging steps, clear writes empty the log', async () => {
    const { t, ctx, events } = await setup();
    const wt = mainWt(t.repo);
    const stageA: WriteIntent<null> = {
      kind: 'stage', label: () => 'stage a.txt', class: 'immediate', undo: () => null, staging: 'step', allowedInProgress: true,
      run: async () => {
        writeFileState(wt, 'a.txt', { mode: 0o100644, bytes: enc('a3\n') });
        await saveIndex(wt, withEntry(await loadIndex(wt), 'a.txt', await entryOfFile(wt, 'a.txt')));
        return null;
      },
    };
    const r = await runWrite(ctx, 1, t.dir, NO, stageA);
    expect(r.staging).toEqual({ undo: 'stage a.txt', redo: null, off: null });
    expect(events.map((e) => e.type)).not.toContain('queueChanged');
    const clear: WriteIntent<null> = { kind: 'commit', label: () => 'x', undo: () => null, run: async () => null };
    expect((await runWrite(ctx, 1, t.dir, NO, clear)).staging).toEqual({ undo: null, redo: null, off: null });
  });

  it("snapshots a plan's paths into the entry, and a save on top of a save of the same file coalesces", async () => {
    const { t, ctx } = await setup();
    const wt = mainWt(t.repo);
    const save = (text: string): WriteIntent<null> => ({
      kind: 'save', label: () => 'save a.txt', class: 'immediate', undo: () => 'restore', staging: 'keep', coalesces: true, allowedInProgress: true,
      plan: async () => ({ snapshot: { paths: ['a.txt'], untracked: [] } }),
      run: async (cx) => {
        cx.partial = true;
        writeFileState(wt, 'a.txt', { mode: 0o100644, bytes: enc(text) });
        const { createSnapshot } = await import('./snapshot');
        cx.after = await createSnapshot(wt, cx.snapshot!.paths, cx.snapshot!.untracked);
        return null;
      },
    });
    await runWrite(ctx, 1, t.dir, NO, save('one\n'));
    await runWrite(ctx, 1, t.dir, NO, save('two\n'));
    const j = ctx.writes.journal(t.dir);
    expect(j.undo.map((e) => e.label)).toEqual(['save a.txt']);
    expect(new TextDecoder().decode(j.undo[0].before!.held.get('a.txt')!.file!.bytes)).toBe('a2\n');
    expect(new TextDecoder().decode(j.undo[0].after!.held.get('a.txt')!.file!.bytes)).toBe('two\n');
    expect(readFileState(wt, 'a.txt')?.bytes).toEqual(enc('two\n'));
  });
});
