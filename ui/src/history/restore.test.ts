import { beforeEach, describe, expect, it, vi } from 'vitest';

const restoreFileApi = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: { restoreFile: restoreFileApi }, errorMessage: (e: unknown) => String(e) }));
const runWrite = vi.hoisted(() => vi.fn(async (_ctx: unknown, send: (c: boolean, a: { discard: boolean }) => Promise<{ outcome: unknown }>) => (await send(false, { discard: false })).outcome));
vi.mock('../write/client', () => ({ runWrite }));
const show = vi.hoisted(() => vi.fn());
vi.mock('../ui/toast', () => ({ useToast: { getState: () => ({ show }) } }));

const { restoreFile } = await import('./restore');
const ctx = { tabId: 't1', repoId: 3, worktree: '/r' };
const sha = 'abcdef0123456789abcdef0123456789abcdef01';

describe('restoreFile (spec #3 §3.8)', () => {
  beforeEach(() => { restoreFileApi.mockReset(); show.mockReset(); });

  it('sends the restore with the answered discard flag as confirm, then toasts what it did', async () => {
    restoreFileApi.mockResolvedValue({ outcome: null, journal: null, staging: null, wip: null });
    expect(await restoreFile(ctx, sha, 'src/a.txt', false)).toBe(true);
    expect(restoreFileApi).toHaveBeenCalledWith(3, '/r', sha, 'src/a.txt', false);
    expect(show).toHaveBeenCalledWith('Restored src/a.txt from abcdef');
    expect(await restoreFile(ctx, sha, 'gone.txt', true)).toBe(true);
    expect(show).toHaveBeenLastCalledWith('Deleted gone.txt');
  });

  it('says nothing more when the write failed or was declined', async () => {
    runWrite.mockResolvedValueOnce(null as never);
    expect(await restoreFile(ctx, sha, 'src/a.txt', false)).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });
});
