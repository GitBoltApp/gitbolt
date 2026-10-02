import { beforeEach, describe, expect, it, vi } from 'vitest';

const follow = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn(async () => true));
const discard = vi.hoisted(() => vi.fn(async () => ({ outcome: null, wip: { worktree: '/r' } })));
const run = vi.hoisted(() => vi.fn());
vi.mock('./follow', () => ({ followOpenFile: follow }));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: confirm }));
vi.mock('../api/client', () => ({ api: { discard } }));
vi.mock('../write/client', () => ({ runWrite: run }));

import { discardAll, writeAndFollow } from './actions';
import { useStaging } from './store';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };

beforeEach(() => {
  vi.clearAllMocks();
  useStaging.setState({ states: {}, committing: {} });
  // runWrite as the real one: sends, answers the outcome, or null when the send throws.
  run.mockImplementation(async (_c: unknown, send: () => Promise<{ outcome: unknown }>) => {
    try { return (await send()).outcome; } catch { return null; }
  });
});

describe('writeAndFollow (spec #2 §7.1)', () => {
  it('follows after a write whose answer carries the fresh lists', async () => {
    expect(await writeAndFollow(ctx, async () => ({ wip: { worktree: '/r' } }) as never)).toBe(true);
    expect(follow).toHaveBeenCalledWith('t', '/r');
  });

  it('does not follow after a failed write', async () => {
    expect(await writeAndFollow(ctx, async () => { throw new Error('boom'); })).toBe(false);
    expect(follow).not.toHaveBeenCalled();
  });

  it('does not follow when the answer has no wip: the cached lists may be stale', async () => {
    expect(await writeAndFollow(ctx, async () => ({ wip: null }) as never)).toBe(true);
    expect(follow).not.toHaveBeenCalled();
  });
});

describe('discardAll', () => {
  it('confirms, then discards everything', async () => {
    expect(await discardAll(ctx)).toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard all changes?', danger: true }));
    expect(discard).toHaveBeenCalledWith(1, '/r', { kind: 'all' });
  });

  it('writes nothing when cancelled', async () => {
    confirm.mockResolvedValueOnce(false);
    expect(await discardAll(ctx)).toBe(false);
    expect(discard).not.toHaveBeenCalled();
  });
});
