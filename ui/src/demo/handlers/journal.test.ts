import { describe, expect, it } from 'vitest';
import { fakeCtx, makeTestRepo } from '../engine/read/testkit';
import { runWrite } from '../engine/write/run';
import { journalHandlers } from './journal';

describe('the journal handlers', () => {
  it('answer the journal state, the dropdown, the staging state and the queue', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const base = await t.commit('Base');
    const ctx = fakeCtx(t.repo);
    expect(await journalHandlers.journalState({ repo: 1, worktree: t.dir }, ctx)).toMatchObject({ undo: null, undoBlocked: 'Nothing to undo' });
    await runWrite(ctx, 1, t.dir, { head: null, refs: {} }, { kind: 'branch', label: () => 'create branch x', undo: () => 'moveRefs', run: async (cx) => cx.cas([{ name: 'refs/heads/x', old: null, new: base }]) });
    expect(await journalHandlers.journalHistory({ repo: 1, worktree: t.dir }, ctx)).toEqual([{ entry: 1, label: 'create branch x', kind: 'branch', atMs: 1_800_000_000_000, touched: ['x'], blocked: null }]);
    expect(await journalHandlers.stagingState({ repo: 1, worktree: t.dir }, ctx)).toEqual({ undo: null, redo: null, off: null });
    expect(await journalHandlers.queueState({ repo: 1 }, ctx)).toEqual({ running: null, queued: [], stopped: null });
    expect([await journalHandlers.queueRemove({ repo: 1, id: 9 }, ctx), await journalHandlers.queueResume({ repo: 1 }, ctx), await journalHandlers.cancelOp({ op: 1 }, ctx)]).toEqual([false, null, null]);
    await expect(journalHandlers.journalState({ repo: 1, worktree: '/demo/nope' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
  });
});
