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
  ])('%s -> %j when every context action is available', (kind, want) => {
    expect(ids(err(kind), full)).toEqual(want);
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

  it('never notifies for Cancelled, uses the spec wording for RefMoved, and never offers to delete a lock', () => {
    expect(describeError(err('Cancelled'))).toBeNull();
    expect(describeError(err('RefMoved'))!.message).toBe('Branch changed outside GitBolt — refresh and retry');
    const locked = describeError(err('IndexLocked'))!;
    expect(locked.message).toMatch(/index\.lock/);
    expect(ids(err('IndexLocked'), full)).not.toContain('remove-lock');
  });

  it('wraps anything thrown as a GbError', () => {
    expect(toGbError(new Error('boom'))).toEqual({ kind: 'Other', message: 'boom', commandId: null, stderr: null });
    expect(toGbError(err('Io')).kind).toBe('Io');
  });
});
