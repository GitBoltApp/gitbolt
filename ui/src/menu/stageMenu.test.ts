import { describe, expect, it, vi } from 'vitest';

const stage = vi.hoisted(() => vi.fn(async () => true));
const discard = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../stage/actions', async (orig) => ({ ...(await orig<typeof import('../stage/actions')>()), stagePaths: stage, discardPaths: discard }));
vi.mock('../app/actions', async (orig) => ({ ...(await orig<typeof import('../app/actions')>()), activeTab: () => ({ id: 't', kind: 'repo' }), activeStore: () => ({ getState: () => ({ repo: 1 }) }) }));

import './builders';
import { buildMenu } from './registry';
import type { FileTarget, MenuEnv } from './menuEnv';

const target = (wip: FileTarget['wip']) => ({ path: 'a.txt', root: '/r', sha: null, upstream: null, diff: { key: 'k', path: 'a.txt', oldPath: null, status: 'M', old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, view: 'diff' }, changed: true, deleted: false, list: 'wip', openIn: { worktree: '/r', path: 'a.txt', line: null, source: null, fallback: null }, wip }) as unknown as FileTarget;
const env = { openers: { list: [], error: null, last: null }, forge: () => null, act: {} } as unknown as MenuEnv;
const labels = (t: FileTarget) => buildMenu('file', t, env).flatMap((r) => (r.kind === 'action' ? [r.label] : []));

describe('the WIP file menu (spec #2 §7.1)', () => {
  it('an unstaged file: Stage and Discard changes first; a staged one: Unstage; elsewhere: neither', () => {
    expect(labels(target({ worktree: '/r', staged: false, oldPath: null, status: 'M' })).slice(0, 2)).toEqual(['Stage', 'Discard changes']);
    expect(labels(target({ worktree: '/r', staged: true, oldPath: null, status: 'M' }))[0]).toBe('Unstage');
    expect(labels(target(null))).not.toContain('Stage');
    expect(labels(target({ worktree: '/r', staged: false, oldPath: null, status: 'U' }))).not.toContain('Stage');
  });

  it('a submodule row offers Stage but no Discard', () => {
    const l = labels(target({ worktree: '/r', staged: false, oldPath: null, status: 'M', submodule: true }));
    expect(l).toContain('Stage');
    expect(l).not.toContain('Discard changes');
  });

  it('runs on the row’s worktree', () => {
    const rows = buildMenu('file', target({ worktree: '/r', staged: false, oldPath: null, status: 'M' }), env);
    const first = rows[0];
    if (first.kind === 'action') first.run();
    expect(stage).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/r' }, ['a.txt']);
  });
});
