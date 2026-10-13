import { describe, expect, it } from 'vitest';
import { hunksHandlers } from './hunks';
import { fakeCtx, makeTestRepo, thirty } from '../engine/read/testkit';

describe('hunk handlers', () => {
  it('answers hunks with their base, and a binary refusal', async () => {
    const t = await makeTestRepo();
    await t.write('f.txt', thirty([]));
    await t.write('b.bin', new Uint8Array([0, 1]));
    await t.commit('Base');
    await t.write('f.txt', thirty([3, 20]));
    await t.write('b.bin', new Uint8Array([0, 2]));
    const ctx = fakeCtx(t.repo);
    const h = await hunksHandlers.wipHunks({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false }, ctx);
    expect(h.hunks.map((x) => [x.del, x.add])).toEqual([[[3], [3]], [[20], [20]]]);
    expect([h.binary, h.refused, h.base.worktree === null]).toEqual([false, null, false]);
    const b = await hunksHandlers.wipHunks({ repo: 1, worktree: t.dir, path: 'b.bin', staged: false }, ctx);
    expect([b.hunks.length, b.binary, b.refused]).toEqual([0, true, 'Binary file: stage the whole file']);
    const sel = { kind: 'lines' as const, old: [{ start: 2, end: 22 }], new: [{ start: 1, end: 4 }] };
    expect(await hunksHandlers.selectionLines({ repo: 1, worktree: t.dir, path: 'f.txt', staged: false, selection: sel }, ctx)).toEqual({ apply: 3, discard: 3 });
    await expect(hunksHandlers.selectionLines({ repo: 1, worktree: t.dir, path: 'b.bin', staged: false, selection: sel }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Binary file: stage the whole file' });
    await expect(hunksHandlers.wipHunks({ repo: 1, worktree: '/demo/nope', path: 'f.txt', staged: false }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
  });
});
