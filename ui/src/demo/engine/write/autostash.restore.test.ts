import { describe, expect, it, vi } from 'vitest';
import type { WriteCx } from './run';

vi.mock('./stash', async (orig) => ({
  ...(await orig<typeof import('./stash')>()),
  applyStash: async () => ({ kind: 'conflicts', paths: ['a.txt'], untracked: false }),
  binaryAmong: async () => {
    throw new Error('listing failed');
  },
}));

describe('restoreAutostash', () => {
  it('maps any error of the restore, not only applyStash, to refused', async () => {
    const { restoreAutostash } = await import('./autostash');
    const cx = { wt: {}, touch: () => {}, command: () => {}, ctx: { emit: () => {} }, op: 1 } as unknown as WriteCx;
    expect(await restoreAutostash(cx, 'a'.repeat(40), 'autostash before x', true)).toEqual({ status: 'refused', index: false, message: 'listing failed' });
  });
});
