import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ removeIndexLock: vi.fn(async () => null) }));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
const confirm = vi.hoisted(() => ({ answer: true, asked: [] as unknown[] }));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: vi.fn(async (req: unknown) => { confirm.asked.push(req); return confirm.answer; }) }));

const { removeStaleLock, writeErrorContext, lockLabel } = await import('./indexLock');
const { useToast } = await import('../ui/toastStore');

const LOCK = { path: '/r/.git/index.lock', mtimeMs: 5, ino: 6, dev: 7 };

describe('Remove stale lock (spec #2 §14)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirm.asked = [];
    useToast.getState().dismiss();
  });

  it('asks first, then removes the lock the error saw', async () => {
    confirm.answer = true;
    await removeStaleLock(3, LOCK);
    expect(confirm.asked).toEqual([expect.objectContaining({ title: 'Remove .git/index.lock?', body: 'Do this only if no other git program is running.', danger: true })]);
    expect(api.removeIndexLock).toHaveBeenCalledWith(3, LOCK);
    expect(useToast.getState().message).toBe('Removed .git/index.lock');
  });

  it('does nothing when the user says no', async () => {
    confirm.answer = false;
    await removeStaleLock(3, LOCK);
    expect(api.removeIndexLock).not.toHaveBeenCalled();
  });

  it('names the lock relative to the repository, and the write context wires removal', async () => {
    expect(lockLabel('/r/.git/worktrees/wt/index.lock')).toBe('.git/worktrees/wt/index.lock');
    confirm.answer = true;
    await writeErrorContext(3, { retry: vi.fn() }).removeLock!({ ...LOCK, path: '/r/.git/worktrees/wt/index.lock' });
    expect(confirm.asked).toEqual([expect.objectContaining({ title: 'Remove .git/worktrees/wt/index.lock?' })]);
    expect(api.removeIndexLock).toHaveBeenCalledWith(3, expect.objectContaining({ ino: 6 }));
  });
});
