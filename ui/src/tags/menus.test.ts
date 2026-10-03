import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { CommitTarget, MenuEnv, SidebarTarget, TagTarget } from '../menu/menuEnv';
import { buildMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import './menus';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const A = 'a'.repeat(40);
const env = (remoteNames: string[]) => ({ write: ctx, remoteNames }) as unknown as MenuEnv;
type Action = Extract<MenuRow, { kind: 'action' }>;
const find = (rows: MenuRow[], id: string) => rows.find((r) => r.kind !== 'separator' && r.id === id);
const tag: TagTarget = { name: 'v1', fullName: 'refs/tags/v1', sha: A };
const ok = { outcome: { op: 7, remote: 'origin', tag: 'v1', upToDate: false, server: { lines: 0, warning: null } }, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null } as never;

afterEach(() => vi.restoreAllMocks());

describe('tag rows (spec #3 §3.9, §4.3)', () => {
  it('Create tag here: Lightweight | Annotated, on a commit (not a WIP row or a stash)', () => {
    const t: CommitTarget = { sha: A, mrRefs: [], isWip: false, isStash: false, branch: null };
    const row = find(buildMenu('commit', t, env([])), 'tag.createHere') as Action;
    expect(row.label).toBe('Create tag here');
    expect(row.variants?.map((v) => v.label)).toEqual(['Lightweight', 'Annotated']);
    expect(find(buildMenu('commit', { ...t, isStash: true }, env([])), 'tag.createHere')).toBeUndefined();
  });
  it('one remote: Push v1 to origin, and Delete | Local | Remote | Both |', () => {
    const rows = buildMenu('tag', tag, env(['origin']));
    expect((find(rows, 'tag.push') as Action).label).toBe('Push v1 to origin');
    expect((find(rows, 'tag.delete') as Action).variants?.map((v) => v.id)).toEqual(['local', 'remote', 'both']);
  });
  it('no remote: no Push, and Delete is local only', () => {
    const rows = buildMenu('tag', tag, env([]));
    expect(find(rows, 'tag.push')).toBeUndefined();
    expect((find(rows, 'tag.delete') as Action).variants?.map((v) => v.id)).toEqual(['local']);
  });
  it('several remotes: Push v1 to ▸ one row each; Delete Remote targets origin', () => {
    const rows = buildMenu('tag', tag, env(['fork', 'origin']));
    const push = find(rows, 'tag.push');
    expect(push?.kind).toBe('submenu');
    expect(push?.kind === 'submenu' && push.rows.map((r) => (r.kind === 'action' ? r.label : ''))).toEqual(['fork', 'origin']);
    expect((find(rows, 'tag.delete') as Action).variants?.find((v) => v.id === 'remote')?.tooltip).toBe("Delete v1 from origin (a push: can't be undone)");
  });
  it("a remote's menu: Push all tags to origin", async () => {
    const push = vi.spyOn(api, 'pushTags').mockResolvedValue(ok);
    const target: SidebarTarget = { what: 'remote', name: 'origin', url: null };
    const row = find(buildMenu('sidebar', target, env(['origin'])), 'remote.pushTags') as Action;
    expect(row.label).toBe('Push all tags to origin');
    row.run();
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith(1, '/r', 'origin', null));
  });
});
