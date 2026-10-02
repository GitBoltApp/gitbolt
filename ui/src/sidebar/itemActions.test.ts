import { GitBranchPlus } from 'lucide-react';
import { expect, it, vi } from 'vitest';
import type { RepoViewStore } from '../repo/store';
import { registerSidebarDoubleClick, registerSidebarHeaderAction, sidebarDoubleClick, sidebarHeaderActions } from './itemActions';
import type { SideItem } from './model';

it('dispatches a double-click by item kind, and lists a section\'s header actions', () => {
  const fn = vi.fn();
  const off = registerSidebarDoubleClick('local', fn);
  const ctx = { tabId: 't', store: {} as RepoViewStore };
  const item = { kind: 'local', key: 'refs/heads/x', name: 'x', target: 'a', time: 0 } as SideItem;
  expect(sidebarDoubleClick(ctx, item)).toBe(true);
  expect(fn).toHaveBeenCalledWith(ctx, item);
  expect(sidebarDoubleClick(ctx, { ...item, kind: 'tag' } as SideItem)).toBe(false);
  off();
  const offH = registerSidebarHeaderAction('worktrees', { id: 'worktree.create', icon: GitBranchPlus, label: 'Create worktree', run: vi.fn() });
  expect(sidebarHeaderActions('worktrees').map((a) => a.id)).toEqual(['worktree.create']);
  expect(sidebarHeaderActions('local')).toEqual([]);
  offH();
});
