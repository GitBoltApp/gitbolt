import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ACTIVITY, MAX_ERRORS, useOps } from './ops';

describe('ops store', () => {
  beforeEach(() => useOps.setState({ ops: {}, prompts: [], errors: [], unread: 0, activity: [] }));

  it('tracks ops, progress, prompts and errors from events', () => {
    const { apply } = useOps.getState();
    apply({ type: 'opStarted', op: 3, kind: 'clone', repo: null, label: '/r/x', interactive: true });
    apply({ type: 'opProgress', op: 3, phase: 'Receiving objects', percent: 40 });
    expect(useOps.getState().ops[3]).toMatchObject({ label: '/r/x', phase: 'Receiving objects', percent: 40 });
    apply({ type: 'authWaiting', prompt: 9, op: 3, repo: null, text: 'Password: ', secret: true });
    expect(useOps.getState().prompts.map((p) => p.prompt)).toEqual([9]);
    apply({ type: 'authResolved', prompt: 9 });
    apply({ type: 'opFinished', op: 3, kind: 'clone', repo: null, outcome: 'ok', message: null, command: null });
    expect(useOps.getState().ops[3]).toBeUndefined();
    expect(useOps.getState().prompts).toEqual([]);
    useOps.getState().pushError('Fetch failed: boom');
    expect(useOps.getState().unread).toBe(1);
    useOps.getState().markRead();
    expect(useOps.getState().unread).toBe(0);
  });

  it('ignores progress for an op it never saw start, and other events', () => {
    const before = useOps.getState();
    before.apply({ type: 'opProgress', op: 7, phase: 'Counting objects', percent: 10 });
    before.apply({ type: 'refsUpdated', repo: 1 });
    expect(useOps.getState().ops).toBe(before.ops);
  });

  it('an op that finishes drops its pending prompts too (the askpass child is gone)', () => {
    const { apply } = useOps.getState();
    apply({ type: 'opStarted', op: 1, kind: 'fetch', repo: 2, label: 'r', interactive: true });
    apply({ type: 'authWaiting', prompt: 4, op: 1, repo: 2, text: 'Username: ', secret: false });
    apply({ type: 'opFinished', op: 1, kind: 'fetch', repo: 2, outcome: 'cancelled', message: null, command: null });
    expect(useOps.getState().prompts).toEqual([]);
  });

  it('logs every finished op to the activity log, background ones too, with its duration (K30)', () => {
    vi.useFakeTimers();
    try {
      const { apply } = useOps.getState();
      vi.setSystemTime(1_000);
      apply({ type: 'opStarted', op: 5, kind: 'fetch', repo: 2, label: 'shop', interactive: false });
      vi.setSystemTime(21_200);
      apply({ type: 'opFinished', op: 5, kind: 'fetch', repo: 2, outcome: 'failed', message: 'Could not resolve host: h', command: null });
      apply({ type: 'opStarted', op: 6, kind: 'fetch', repo: 2, label: 'shop', interactive: true });
      vi.setSystemTime(22_000);
      apply({ type: 'opFinished', op: 6, kind: 'fetch', repo: 2, outcome: 'ok', message: null, command: null });
      expect(useOps.getState().activity).toEqual([
        { at: 22_000, kind: 'fetch', label: 'shop', background: false, durationMs: 800, outcome: 'ok', message: null, command: null },
        { at: 21_200, kind: 'fetch', label: 'shop', background: true, durationMs: 20_200, outcome: 'failed', message: 'Could not resolve host: h', command: null },
      ]);
      expect(useOps.getState().errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the newest MAX_ACTIVITY activity entries, newest first', () => {
    const { apply } = useOps.getState();
    for (let i = 0; i < MAX_ACTIVITY + 3; i++) {
      apply({ type: 'opStarted', op: i, kind: 'fetch', repo: 1, label: `r${i}`, interactive: false });
      apply({ type: 'opFinished', op: i, kind: 'fetch', repo: 1, outcome: 'ok', message: null, command: null });
    }
    const { activity } = useOps.getState();
    expect(activity).toHaveLength(MAX_ACTIVITY);
    expect(activity[0].label).toBe(`r${MAX_ACTIVITY + 2}`);
  });

  it('keeps the newest MAX_ERRORS errors, newest first', () => {
    for (let i = 0; i < MAX_ERRORS + 5; i++) useOps.getState().pushError(`e${i}`);
    const { errors } = useOps.getState();
    expect(errors).toHaveLength(MAX_ERRORS);
    expect(errors[0].message).toBe(`e${MAX_ERRORS + 4}`);
    useOps.getState().clearErrors();
    expect(useOps.getState()).toMatchObject({ errors: [], unread: 0 });
  });
});
