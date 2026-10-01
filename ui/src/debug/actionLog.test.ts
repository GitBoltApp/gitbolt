import { beforeEach, describe, expect, it, vi } from 'vitest';

const logFrontend = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../api/client', () => ({ api: { logFrontend }, errorMessage: (e: { message?: string }) => e?.message ?? String(e) }));

const { ACTION_LOG_CAPACITY, actionLogText, runMenuRow, track, useActionLog } = await import('./actionLog');

describe('action log (R11)', () => {
  beforeEach(() => {
    useActionLog.getState().clear();
    logFrontend.mockClear();
  });

  it('records a sync success at once, and logs it to the file', () => {
    const fail = vi.fn();
    track('view.zoomIn', 'Zoom in', () => {}, fail);
    const [e] = useActionLog.getState().entries;
    expect(e).toMatchObject({ id: 'view.zoomIn', label: 'Zoom in', ok: true, error: null, source: 'action' });
    expect(fail).not.toHaveBeenCalled();
    expect(logFrontend).toHaveBeenCalledWith('info', expect.stringMatching(/^action view\.zoomIn ok in \d+ ms$/), null);
  });

  it('a quiet run (a held shortcut repeating) logs no success, but still logs a failure', () => {
    const fail = vi.fn();
    const run = vi.fn();
    track('view.zoomIn', 'Zoom in', run, fail, true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(useActionLog.getState().entries).toHaveLength(0);
    expect(logFrontend).not.toHaveBeenCalled();
    track('a.sync', 'Sync', () => { throw new Error('boom'); }, fail, true);
    expect(useActionLog.getState().entries).toHaveLength(1);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('records a sync throw and an async rejection as failures, and hands them on', async () => {
    const fail = vi.fn();
    track('a.sync', 'Sync', () => { throw new Error('boom'); }, fail);
    track('repo.fetch', 'Fetch', () => Promise.reject({ kind: 'AuthFailed', message: 'denied', commandId: 3, stderr: null }), fail);
    await vi.waitFor(() => expect(useActionLog.getState().entries).toHaveLength(2));
    const [a, b] = useActionLog.getState().entries;
    expect(a).toMatchObject({ id: 'a.sync', ok: false, error: 'boom' });
    expect(b).toMatchObject({ id: 'repo.fetch', ok: false, error: 'denied' });
    expect(b.seq).toBe(a.seq + 1);
    expect(fail).toHaveBeenCalledTimes(2);
    expect(logFrontend).toHaveBeenCalledWith('warn', expect.stringMatching(/^action repo\.fetch failed in \d+ ms: denied$/), null);
  });

  it('keeps only the newest entries', () => {
    for (let i = 0; i < ACTION_LOG_CAPACITY + 5; i++) useActionLog.getState().record({ at: i, id: `a${i}`, label: '', ok: true, ms: 0, error: null, source: 'action' });
    const entries = useActionLog.getState().entries;
    expect(entries).toHaveLength(ACTION_LOG_CAPACITY);
    expect(entries[0].id).toBe('a5');
  });

  it('a menu row is recorded once: as itself, or as the action it invoked', () => {
    const fail = vi.fn();
    runMenuRow('copy.sha', 'Copy SHA', () => {}, fail);
    runMenuRow('file.settings', 'Settings', () => track('file.settings', 'Settings', () => {}, fail), fail);
    const entries = useActionLog.getState().entries;
    expect(entries.map((e) => [e.id, e.source])).toEqual([['copy.sha', 'menu'], ['file.settings', 'action']]);
  });

  it('a throwing menu row is recorded and handed on, not thrown', () => {
    const fail = vi.fn();
    expect(() => runMenuRow('x', 'X', () => { throw new Error('nope'); }, fail)).not.toThrow();
    expect(useActionLog.getState().entries[0]).toMatchObject({ id: 'x', ok: false, error: 'nope', source: 'menu' });
    expect(fail).toHaveBeenCalledOnce();
  });

  it('renders as plain text, newest first', () => {
    useActionLog.getState().record({ at: 0, id: 'a.one', label: 'One', ok: true, ms: 3, error: null, source: 'action' });
    useActionLog.getState().record({ at: 1000, id: 'a.two', label: 'Two', ok: false, ms: 12, error: 'bad', source: 'menu' });
    const text = actionLogText([...useActionLog.getState().entries].reverse(), 2000);
    expect(text.indexOf('Two')).toBeLessThan(text.indexOf('One'));
    expect(text).toContain('a.two');
    expect(text).toContain('menu');
    expect(text).toContain('failed');
    expect(text).toContain('bad');
  });
});
