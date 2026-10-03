import { describe, expect, it, vi } from 'vitest';
import { buildMenu } from '../menu/registry';
import type { MenuEnv, SidebarTarget, WipTarget } from '../menu/menuEnv';

const setActiveWorktree = vi.hoisted(() => vi.fn());
vi.mock('./active', () => ({ setActiveWorktree, openWorktreeTab: vi.fn() }));
await import('./menus');

const env = (activeWorktree: string) => ({ activeWorktree, mainWorktree: '/r', write: { tabId: 't', repoId: 1, worktree: activeWorktree }, worktreeShown: (p: string) => p.replace('/r-', '../r-') }) as unknown as MenuEnv;
const ids = (rows: ReturnType<typeof buildMenu>) => rows.flatMap((r) => (r.kind === 'action' ? [r.id] : []));

describe('worktree rows (spec #2 §14)', () => {
  it('a sidebar worktree row offers Switch to and Open in a new tab', () => {
    const t: SidebarTarget = { what: 'worktree', path: '/r-x', branch: 'x', head: 'b' };
    const rows = buildMenu('sidebar', t, env('/r'));
    expect(ids(rows)).toEqual(expect.arrayContaining(['sidebar.worktree.switch', 'sidebar.worktree.openTab']));
    const sw = rows.find((r) => r.kind === 'action' && r.id === 'sidebar.worktree.switch');
    if (sw?.kind === 'action') sw.run();
    expect(setActiveWorktree).toHaveBeenCalledWith('t', '/r-x');
    // The active one has nothing to switch to: no row.
    expect(ids(buildMenu('sidebar', t, env('/r-x')))).not.toContain('sidebar.worktree.switch');
  });
  it('a WIP row offers Switch to this worktree unless it is the active one', () => {
    const other: WipTarget = { worktree: '/r-x', name: 'r-x', active: false };
    expect(ids(buildMenu('wip', other, env('/r')))).toEqual(['wip.switch', 'wip.openTab']);
    expect(ids(buildMenu('wip', { ...other, active: true }, env('/r-x')))).toEqual(['wip.openTab']);
  });

  it('Remove is not offered on the main worktree, and greyed for a locked one', () => {
    const rows = (path: string, locked = false) => buildMenu('sidebar', { what: 'worktree', path, branch: 'x', head: 'b' } as SidebarTarget, { ...env('/r'), sidebar: { worktrees: [{ path: '/r', isMain: true, locked: false }, { path, isMain: path === '/r', locked }] } } as unknown as MenuEnv);
    const remove = (r: ReturnType<typeof buildMenu>) => r.find((x) => x.kind === 'action' && x.id === 'sidebar.worktree.remove');
    const reason = (r: ReturnType<typeof buildMenu>) => { const x = remove(r); return x?.kind === 'action' ? x.disabledReason ?? null : 'missing'; };
    expect(reason(rows('/r'))).toBe('missing');
    expect(reason(rows('/r-x', true))).toBe('Locked: unlock it first');
    expect(reason(rows('/r-x'))).toBeNull();
  });
});
