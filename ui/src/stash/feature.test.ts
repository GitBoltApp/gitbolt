import { describe, expect, it } from 'vitest';
import type { CommitTarget, MenuEnv, SidebarTarget, WipTarget } from '../menu/menuEnv';
import { buildMenu } from '../menu/registry';
import './feature';

const env = { write: { tabId: 't', repoId: 1, worktree: '/r' } } as unknown as MenuEnv;
const ids = (rows: ReturnType<typeof buildMenu>) => rows.flatMap((r) => (r.kind === 'action' ? [r.id] : []));

describe('stash rows (spec #2 §10)', () => {
  it('a sidebar stash row and a graph stash node get Apply, Pop, Delete', () => {
    const row: SidebarTarget = { what: 'stash', sha: 'oid', message: 'On main: x' };
    expect(ids(buildMenu('sidebar', row, env))).toEqual(expect.arrayContaining(['stash.apply', 'stash.pop', 'stash.drop']));
    const node: CommitTarget = { sha: 'oid', mrRefs: [], isWip: false, isStash: true, branch: null };
    expect(ids(buildMenu('commit', node, env)).filter((i) => i.startsWith('stash.'))).toEqual(['stash.apply', 'stash.pop', 'stash.drop']);
    expect(ids(buildMenu('commit', { ...node, isStash: false }, env)).filter((i) => i.startsWith('stash.'))).toEqual([]);
  });
  it('a WIP row offers Stash changes for its own worktree', () => {
    const t: WipTarget = { worktree: '/r-x', name: 'r-x', active: false };
    expect(ids(buildMenu('wip', t, env))).toContain('wip.stash');
  });
});
