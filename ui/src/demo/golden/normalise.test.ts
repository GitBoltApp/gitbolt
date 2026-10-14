import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { GOLDEN } from '../testing';
import { makeEventNormaliser, normaliseError, normaliseResponse, refusedBy, UNTIMED, unreachable, unreachableEvents } from './normalise';

describe('golden normalisation', () => {
  it('digests large base64 and dumps as the generator does, and masks the git-lfs version', async () => {
    const big = 'A'.repeat(20_000);
    const out = (await normaliseResponse('diffContents', { new: { base64: big, text: big }, old: null, dropped: undefined })) as Record<string, unknown> & { new: { base64: string; text: string } };
    expect(out.new.base64).toMatch(/^sha256:[0-9a-f]{64}:20000$/);
    expect(out.new.text).toBe(big);
    expect('dropped' in out).toBe(false);
    expect(await normaliseResponse('diffContents', out)).toEqual(out);
    expect(await normaliseResponse('lfsStatus', { used: true, version: null })).toEqual({ used: true, version: '<git-lfs>' });
  });
});

describe('normalise', () => {
  it("keeps an error's kind, message and detail", () => {
    expect(normaliseError({ kind: 'DirtyWorktree', message: 'x', commandId: 7, stderr: 'error: x\n', detail: { kind: 'applyWithoutIndex' } })).toEqual({ kind: 'DirtyWorktree', message: 'x', detail: { kind: 'applyWithoutIndex' } });
    expect(normaliseError({ kind: 'Stale', message: 'y', commandId: null, stderr: null })).toEqual({ kind: 'Stale', message: 'y' });
  });

  it('masks HTTP timing and token storage where the method has them, op ids, and the sync push hook output', async () => {
    const forge = { fetchedAt: 1, notModified: false, pollIntervalSecs: null, value: { iid: 1, fetchedAt: 2 } };
    // Only where the method has them: a field of that name elsewhere is still compared.
    expect(await normaliseResponse('forgeMrDetail', forge)).toEqual({ fetchedAt: '<untimed>', notModified: '<untimed>', pollIntervalSecs: '<untimed>', value: { iid: 1, fetchedAt: 2 } });
    expect(await normaliseResponse('forgeAccounts', [{ account: { host: 'h', addedAt: 3, storage: 'file', versionCheckedAt: 4 } }])).toEqual([{ account: { host: 'h', addedAt: '<untimed>', storage: '<untimed>', versionCheckedAt: '<untimed>' } }]);
    // A field one side leaves out isn't added: the comparison then fails.
    expect(await normaliseResponse('forgeCachedMrs', { badges: { fetchedAt: '<untimed>', mrs: [] }, list: null })).toEqual({ badges: { fetchedAt: '<untimed>', mrs: [] }, list: null });
    expect(await normaliseResponse('forgeLabels', [{ name: 'hud', addedAt: 6 }])).toEqual([{ name: 'hud', addedAt: 6 }]);
    expect(await normaliseResponse('fetch', { status: 'done', changed: true, server: { lines: 0, warning: null }, op: 7 })).toEqual({ status: 'done', changed: true, server: { lines: 0, warning: null }, op: '<op>' });
    expect(await normaliseResponse('fetch', { status: 'skipped', reason: 'busy' })).toEqual({ status: 'skipped', reason: 'busy' });
    const push = { journal: {}, outcome: { op: 5, remote: 'origin', server: { lines: 1, warning: null } } };
    expect(await normaliseResponse('push', push, 'sync')).toEqual({ journal: {}, outcome: { op: '<op>', remote: 'origin', server: '<server>' } });
    expect(await normaliseResponse('push', push, 'forge_lab')).toEqual({ journal: {}, outcome: { op: '<op>', remote: 'origin', server: { lines: 1, warning: null } } });
    expect(await normaliseResponse('pull', push, 'sync')).toEqual({ journal: {}, outcome: { op: '<op>', remote: 'origin', server: { lines: 1, warning: null } } });
    expect(await normaliseResponse('commit', push, 'sync')).toEqual(push);
  });

  it('keeps every refsUpdated: the demo side stays strict (the recorder collapses the core\'s runs)', () => {
    const ev = { type: 'refsUpdated', repo: 1 };
    expect(makeEventNormaliser()([ev, ev])).toEqual([ev, ev]);
  });

  it('every <untimed> in the goldens sits where UNTIMED says', () => {
    const misplaced: string[] = [];
    const walk = (v: unknown, path: string, at: string, allowed: string[]) => {
      if (v === '<untimed>' && !allowed.includes(path)) misplaced.push(`${at}: ${path}`);
      if (Array.isArray(v)) for (const x of v) walk(x, path ? `${path}.[]` : '[]', at, allowed);
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, at, allowed);
    };
    let seen = 0;
    for (const dir of readdirSync(GOLDEN).filter((d) => d.includes('@'))) {
      for (const f of readdirSync(`${GOLDEN}/${dir}`).filter((x) => x.endsWith('.json'))) {
        const g = JSON.parse(readFileSync(`${GOLDEN}/${dir}/${f}`, 'utf8')) as { request: { method: string }; response?: unknown; events?: unknown[] };
        seen += JSON.stringify(g).split('"<untimed>"').length - 1;
        walk(g.response, '', `${dir}/${f}`, UNTIMED[g.request.method] ?? []);
        walk(g.events ?? [], '', `${dir}/${f} events`, []);
      }
    }
    expect(misplaced).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });

  it("masks only the sync scenario's fetch from the unreachable remote, and only each side's own refusal", () => {
    expect(unreachable('sync', { method: 'fetch', params: { repo: 1, background: false, remote: 'alice' } })).toBe(true);
    expect(unreachable('sync', { method: 'fetch', params: { repo: 1, background: false } })).toBe(false);
    expect(unreachable('basic', { method: 'fetch', params: { repo: 1, background: false, remote: 'alice' } })).toBe(false);
    expect(refusedBy.demo({ kind: 'Other', message: 'Not in the demo: fetching from git.example.invalid' })).toBe(true);
    expect(refusedBy.demo({ kind: 'Network', message: 'Not in the demo: fetching from git.example.invalid' })).toBe(false);
    expect(refusedBy.demo({ kind: 'Other', message: "transport 'https' not allowed" })).toBe(false);
    expect(refusedBy.core({ kind: 'Other', message: "transport 'https' not allowed" })).toBe(true);
    const finished = { type: 'opFinished', op: 1, kind: 'fetch', repo: 1, outcome: 'failed', message: "transport 'https' not allowed", command: 'git fetch' };
    expect(unreachableEvents([{ type: 'opStarted', op: 1 }, finished], 'core')).toEqual([{ type: 'opStarted', op: 1 }, { ...finished, message: '<unreachable>' }]);
    expect(unreachableEvents([finished], 'demo')).toEqual([finished]);
  });

  it("masks a write result's WIP versions", async () => {
    const r = { outcome: null, journal: {}, staging: {}, wip: { staged: { files: [], version: '1' }, unstaged: { files: [], version: '2' }, version: '12345' } };
    expect(await normaliseResponse('stage', r)).toEqual({ ...r, wip: { staged: { files: [], version: '<version>' }, unstaged: { files: [], version: '<version>' }, version: '<version>' } });
    expect(await normaliseResponse('stage', { ...r, wip: null })).toEqual({ ...r, wip: null });
  });

  it('renumbers ops and queue items by first appearance, masks versions, and drops progress', () => {
    const n = makeEventNormaliser();
    const first = n([
      { type: 'queueChanged', repo: 1, running: null, queued: [{ id: 40, label: 'x', kind: 'commit', op: 900 }], stopped: null },
      { type: 'opStarted', op: 900, kind: 'commit', repo: 1, label: 'x', interactive: true },
      { type: 'opProgress', op: 900, text: '50%' },
      { type: 'repoChanged', repo: 1, kinds: ['index'], worktrees: ['/demo/basic'], versions: { '/demo/basic': 'abc' } },
    ]);
    expect(first).toEqual([
      { type: 'queueChanged', repo: 1, running: null, queued: [{ id: 1, label: 'x', kind: 'commit', op: 1 }], stopped: null },
      { type: 'opStarted', op: 1, kind: 'commit', repo: 1, label: 'x', interactive: true },
      { type: 'repoChanged', repo: 1, kinds: ['index'], worktrees: ['/demo/basic'], versions: { '/demo/basic': '<version>' } },
    ]);
    expect(n([{ type: 'opFinished', op: 905, kind: 'stage', repo: 1, outcome: 'ok', message: null, command: null }])).toEqual([{ type: 'opFinished', op: 2, kind: 'stage', repo: 1, outcome: 'ok', message: null, command: null }]);
  });

  it("renumbers an autostash step's op and an auth prompt's op and prompt", () => {
    const n = makeEventNormaliser();
    expect(
      n([
        { type: 'opStarted', op: 70, kind: 'merge', repo: 1, label: 'merge', interactive: true },
        { type: 'opStashStep', op: 70, step: 'saving', message: 'Saving your changes' },
        { type: 'authWaiting', prompt: 12, op: 70, repo: 1, text: 'Password', secret: true },
        { type: 'authResolved', prompt: 12 },
      ]),
    ).toEqual([
      { type: 'opStarted', op: 1, kind: 'merge', repo: 1, label: 'merge', interactive: true },
      { type: 'opStashStep', op: 1, step: 'saving', message: 'Saving your changes' },
      { type: 'authWaiting', prompt: 1, op: 1, repo: 1, text: 'Password', secret: true },
      { type: 'authResolved', prompt: 1 },
    ]);
  });
});
