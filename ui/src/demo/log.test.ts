import { describe, expect, it } from 'vitest';
import { commandEntries, paramsSummary, recordCommand, recordRequest, requestEntries } from './log';

describe('demo logs', () => {
  it('records requests oldest first, without content, and skips its own traffic', () => {
    recordRequest('fileList', { repo: 1, spec: { kind: 'wip', worktree: '/demo/x', staged: false } }, 1000, 2.5, null);
    recordRequest('writeWorktreeFile', { repo: 1, path: 'a.txt', text: 'secret body', base: 'x' }, 1001, 1, { kind: 'Stale', message: 'changed', commandId: null, stderr: null });
    recordRequest('requestLog', undefined, 1002, 0, null);
    const log = requestEntries().slice(-2);
    expect(log.map((e) => [e.method, e.error, e.errorMessage])).toEqual([['fileList', null, null], ['writeWorktreeFile', 'Stale', 'changed']]);
    expect(log[1].params).not.toContain('secret');
    expect(log[1].id).toBeGreaterThan(log[0].id);
    expect(paramsSummary({ path: 'x'.repeat(200) }).length).toBeLessThan(200);
  });

  it('keeps the commands the writes stand for', () => {
    recordCommand(['commit', '-m', 'x'], '/demo/x', 3);
    expect(commandEntries().at(-1)).toMatchObject({ args: ['commit', '-m', 'x'], cwd: '/demo/x', exitCode: 0, stderr: '' });
  });

  it('summarises params as the core does: identifying keys only, values cut, redacted', () => {
    expect(paramsSummary({ repo: 3, limit: null, text: 'hello', spec: { kind: 'wip', worktree: '/demo/x', staged: false } })).toBe('repo=3 kind=wip worktree=/demo/x staged=false');
    expect(paramsSummary({ path: 'two words' })).toBe('path="two words"');
    expect(paramsSummary({ url: 'https://oauth2:glpat-FAKE-00000000000000000000@gitlab.example.com/a/b.git' })).toBe('url=https://***@gitlab.example.com/a/b.git');
    expect(paramsSummary({ repo: 1, path: 'p'.repeat(300) }).length).toBeLessThanOrEqual(241);
    expect(paramsSummary(undefined)).toBe('');
  });

  it('reads only typed structs, never a free-form map', () => {
    expect(paramsSummary({ settings: { name: 'x', url: 'https://u:p@h/r' } })).toBe('');
    expect(paramsSummary({ profile: { name: 'x', host: 'h' }, repo: 2 })).toBe('repo=2');
    expect(paramsSummary({ repo: 1, expect: { path: 'abc', name: 'def' } })).toBe('repo=1');
  });

  it('redacts a value before cutting it, so a credential straddling the cut cannot leak', () => {
    const url = `https://${'u'.repeat(60)}:${'p'.repeat(70)}@h/x`;
    const text = paramsSummary({ url });
    expect(text).toBe('url=https://***@h/x');
    expect(text).not.toContain('ppp');
  });

  it('caps the error message by code point, never splitting a surrogate pair', () => {
    recordRequest('clone', { url: 'x' }, 1004, 1, { kind: 'Other', message: '😀'.repeat(2001), commandId: null, stderr: null });
    expect(requestEntries().at(-1)?.errorMessage).toBe('😀'.repeat(2000));
  });

  it('redacts the error message and the command arguments', () => {
    recordRequest('push', { repo: 1 }, 1003, 1, { kind: 'AuthFailed', message: 'token glpat-FAKE-00000000000000000000 rejected', commandId: null, stderr: null });
    expect(requestEntries().at(-1)).toMatchObject({ error: 'AuthFailed', errorMessage: 'token *** rejected' });
    recordCommand(['push', 'https://user:hunter2@example.com/x.git'], '/demo/x', 1);
    expect(commandEntries().at(-1)?.args).toEqual(['push', 'https://***@example.com/x.git']);
  });
});
