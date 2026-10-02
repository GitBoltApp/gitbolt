import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { LocalBranch } from '../api/gen/LocalBranch';
import { useToast } from '../ui/toast';
import { forceText, pushBranch, pushHooks, pushTooltip } from './push';

const confirm = vi.fn(async () => true);
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: (...a: unknown[]) => confirm(...(a as [])) }));

const main: LocalBranch = { name: 'main', fullName: 'refs/heads/main', target: 'a'.repeat(40), upstream: 'origin/main', ahead: 1, behind: 0, gone: false, tipTime: 0, summary: '', author: '', isHead: true, worktree: null, checkedOut: null, pushTarget: 'origin/main', pushBehind: 3 };
const ctx = { tabId: 't', repoId: 1, worktree: '/r' };

describe('push (spec #2 §12.3)', () => {
  beforeEach(() => { vi.restoreAllMocks(); useToast.getState().dismiss(); });

  it('the tooltip names the target', () => {
    expect(pushTooltip(main, 'main')).toEqual({ tooltip: 'Push main to origin/main', disabled: false });
    expect(pushTooltip({ ...main, upstream: null, pushTarget: null }, 'main').tooltip).toBe('Push main to origin and track it');
    expect(pushTooltip(undefined, null)).toEqual({ tooltip: 'HEAD is detached', disabled: true });
  });

  it('the force confirmation counts what it replaces', () => {
    expect(forceText(main)).toBe("Force push main to origin/main? It replaces 3 commits on origin/main that aren't in main. A push can't be undone.");
    expect(forceText({ ...main, pushBehind: 1 })).toContain('It replaces 1 commit on origin/main');
  });

  it('a force with nothing counted does not claim 0 commits; the tooltip names the remote', () => {
    expect(forceText({ ...main, pushBehind: 0 })).toContain('may replace commits on the server');
    expect(forceText({ ...main, pushBehind: null })).not.toContain('0 commits');
    expect(pushTooltip({ ...main, pushTarget: null }, 'main', 'up').tooltip).toBe('Push main to up and track it');
  });

  it('a rejection offers Pull and Force push…', async () => {
    pushHooks.pull = vi.fn();
    vi.spyOn(api, 'push').mockRejectedValue({ kind: 'NonFastForward', message: 'rejected', commandId: 4, stderr: null });
    await pushBranch(ctx, main);
    const t = useToast.getState();
    expect(t.message).toBe("origin/main has commits main doesn't have");
    expect(t.actions.map((a) => a.label)).toEqual(['Pull', 'Force push…', 'Details']);
  });

  it('success toasts the target with the server output link', async () => {
    vi.spyOn(api, 'push').mockResolvedValue({ outcome: { op: 9, branch: 'main', remote: 'origin', dst: 'main', upToDate: false, server: { lines: 1, warning: null } }, journal: { undo: null, redo: null, undoBlocked: "Push can't be undone", redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null } as never);
    await pushBranch(ctx, main);
    expect(useToast.getState().message).toBe('Pushed main to origin/main');
    expect(useToast.getState().actions[0].label).toBe('Server output (1 line)');
  });
});
