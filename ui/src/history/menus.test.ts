import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MenuRow } from '../menu/types';

vi.mock('../api/client', () => ({ api: new Proxy({}, { get() { throw new Error('menu builders must never call the backend'); } }) }));
const openFileHistory = vi.hoisted(() => vi.fn(() => true));
vi.mock('./open', () => ({ openFileHistory }));
const restoreFile = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./restore', () => ({ restoreFile }));
vi.mock('../app/actions', () => ({ activeTab: () => ({ id: 't1' }), activeStore: () => null }));

const { buildMenu } = await import('../menu/registry');
beforeAll(async () => { await import('./menus'); });
import type { FileTarget, MenuEnv } from '../menu/menuEnv';

type Action = Extract<MenuRow, { kind: 'action' }>;
const A = 'a'.repeat(40);
const write = { tabId: 't1', repoId: 1, worktree: '/r' };
const env = (over: Partial<MenuEnv> = {}) => ({ forge: () => null, openers: { list: [], error: null, last: null }, act: {}, headBranch: 'main', headSha: A, inGraph: () => true, write, sidebar: null, labelsAt: () => [], activeWorktree: '/r', mainWorktree: '/r', inProgress: null, worktreeShown: (p: string) => p, ...over }) as unknown as MenuEnv;
const target = (over: Partial<FileTarget> = {}, absent = false): FileTarget => ({
  path: 'src/story.txt', root: '/r', sha: A, upstream: null, changed: true, deleted: absent, list: 'commit', wip: null,
  diff: { key: `${JSON.stringify({ kind: 'commit', id: A, parent: 0 })}|src/story.txt`, path: 'src/story.txt', oldPath: null, status: absent ? 'D' : 'M', old: { kind: 'object', oid: 'o'.repeat(40) }, new: absent ? { kind: 'absent' } : { kind: 'object', oid: 'n'.repeat(40) }, view: 'diff' },
  openIn: { worktree: '/r', path: 'src/story.txt', line: null, source: null, fallback: null }, ...over,
});
const rows = (t: FileTarget, e = env()) => buildMenu<FileTarget, MenuEnv>('file', t, e).filter((r): r is Action => r.kind === 'action' && ['file.fileHistory', 'file.blame', 'file.restore'].includes(r.id));

describe('the file menu\'s history rows (spec #3 §4.2, §3.8)', () => {
  it('a commit\'s file: Restore from <sha>, File history, Blame', () => {
    const r = rows(target());
    expect(r.map((x) => x.label)).toEqual(['Restore from aaaaaa', 'File history', 'Blame']);
    r[1].run();
    expect(openFileHistory).toHaveBeenLastCalledWith('t1', { path: 'src/story.txt', rev: A }, false);
    r[2].run();
    expect(openFileHistory).toHaveBeenLastCalledWith('t1', { path: 'src/story.txt', rev: A }, true);
    r[0].run();
    expect(restoreFile).toHaveBeenLastCalledWith(write, A, 'src/story.txt', false);
  });

  it('a file the commit deleted offers "Delete <path>"', () => {
    const r = rows(target({}, true));
    expect(r[0].label).toBe('Delete src/story.txt');
    r[0].run();
    expect(restoreFile).toHaveBeenLastCalledWith(write, A, 'src/story.txt', true);
  });

  it('impossible rows are hidden: no restore without a write target or mid-merge; nothing for a new WIP file', () => {
    expect(rows(target(), env({ write: null })).map((x) => x.id)).toEqual(['file.fileHistory', 'file.blame']);
    expect(rows(target(), env({ inProgress: 'merge' })).map((x) => x.id)).toEqual(['file.fileHistory', 'file.blame']);
    const fresh = target({ list: 'wip', sha: null, wip: { worktree: '/r', staged: false, oldPath: null, status: 'A' } });
    expect(rows(fresh)).toEqual([]);
  });
});
