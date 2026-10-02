import { describe, expect, it, vi } from 'vitest';
import type { GbError } from '../api/gen/GbError';
import type { GbErrorKind } from '../api/gen/GbErrorKind';
import { actionsFor, describeError, toGbError } from './describe';

const err = (kind: GbErrorKind, commandId: number | null = 7): GbError => ({ kind, message: `m-${kind}`, commandId, stderr: 'fatal: x' });
const deps = () => ({ openDetails: vi.fn(), copy: vi.fn(() => Promise.resolve()) });
const ids = (e: GbError, ctx = {}) => actionsFor(e, ctx, deps()).map((a) => a.id);
const full = { retry: vi.fn(), refresh: vi.fn(), removeRecent: vi.fn() };

describe('per-kind error actions (spec §16.1)', () => {
  it.each<[GbErrorKind, string[]]>([
    ['AuthFailed', ['retry', 'details']],
    ['NonFastForward', ['refresh', 'details']],
    ['Conflict', ['refresh', 'details']],
    ['DirtyWorktree', ['refresh', 'details']],
    ['RefMoved', ['refresh', 'details']],
    ['IndexLocked', ['retry', 'details']],
    ['NotFound', ['remove-recent', 'details']],
    ['InvalidInput', []],
    ['GitTooOld', []],
    ['Io', ['copy', 'details']],
    ['Other', ['copy', 'details']],
    ['Cancelled', []],
    ['HookFailed', ['retry', 'details']],
    ['InProgress', ['details']],
    ['Stale', ['refresh', 'details']],
  ])('%s -> %j when every context action is available', (kind, want) => {
    expect(ids(err(kind), full)).toEqual(want);
  });

  it('titles a hook failure by its hook, and says what is in progress or went stale', () => {
    const hook: GbError = { kind: 'HookFailed', message: 'lint failed: a.php', commandId: 3, stderr: null, detail: { kind: 'hook', hook: 'pre-commit' } };
    expect(describeError(hook)).toEqual({ title: 'pre-commit hook failed', message: 'lint failed: a.php' });
    expect(describeError({ ...hook, detail: undefined })).toEqual({ title: 'A hook failed', message: 'lint failed: a.php' });
    expect(describeError({ kind: 'InProgress', message: 'A rebase is in progress', commandId: null, stderr: null })).toEqual({ title: 'A rebase is in progress', message: 'Finish or abort it first' });
    expect(describeError({ kind: 'Stale', message: 'a.php changed since it was shown', commandId: null, stderr: null })).toEqual({ title: 'a.php changed since it was shown', message: 'Refreshed: try again' });
  });

  it('offers only what the context supports, and Details only with a command id', () => {
    expect(ids(err('AuthFailed'))).toEqual(['details']);
    expect(ids(err('Other', null))).toEqual(['copy']);
  });

  it('runs Details against the command log and Copy with the error text', async () => {
    const d = deps();
    const acts = actionsFor(err('Other'), {}, d);
    void acts.find((a) => a.id === 'details')!.run();
    expect(d.openDetails).toHaveBeenCalledWith(7);
    await acts.find((a) => a.id === 'copy')!.run();
    expect(d.copy).toHaveBeenCalledWith('Something went wrong\nm-Other\nfatal: x');
  });

  it('never notifies for Cancelled, uses the spec wording for RefMoved, and offers no lock removal without the lock\'s detail', () => {
    expect(describeError(err('Cancelled'))).toBeNull();
    expect(describeError(err('RefMoved'))!.message).toBe('Branch changed outside GitBolt — refresh and retry');
    const locked = describeError(err('IndexLocked'))!;
    expect(locked.message).toMatch(/index\.lock/);
    expect(ids(err('IndexLocked'), full)).not.toContain('remove-lock');
  });

  it('offers Remove stale lock for an index lock when the context can remove it', async () => {
    const locked: GbError = { kind: 'IndexLocked', message: "Unable to create '/r/.git/index.lock': File exists.", commandId: 7, stderr: null, detail: { kind: 'indexLock', path: '/r/.git/index.lock', mtimeMs: 5, ino: 6, dev: 7 } };
    const removeLock = vi.fn();
    const acts = actionsFor(locked, { ...full, removeLock }, deps());
    expect(acts.map((a) => a.id)).toEqual(['remove-lock', 'retry', 'details']);
    expect(acts[0].label).toBe('Remove stale lock');
    await acts[0].run();
    expect(removeLock).toHaveBeenCalledWith({ path: '/r/.git/index.lock', mtimeMs: 5, ino: 6, dev: 7 });
    expect(describeError(locked)!.message).not.toMatch(/yourself/);
    // Without the detail there is nothing to remove.
    expect(ids({ ...locked, detail: undefined }, { ...full, removeLock })).toEqual(['retry', 'details']);
  });

  it('wraps anything thrown as a GbError', () => {
    expect(toGbError(new Error('boom'))).toEqual({ kind: 'Other', message: 'boom', commandId: null, stderr: null });
    expect(toGbError(err('Io')).kind).toBe('Io');
  });
});
