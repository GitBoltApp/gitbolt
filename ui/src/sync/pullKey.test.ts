import { beforeEach, describe, expect, it, vi } from 'vitest';

const pull = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./pull', async (orig) => ({ ...(await orig<typeof import('./pull')>()), pull }));

import { actionForCombo, runAction } from '../app/actions';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { activeTabWith } from '../app/testShell';
import './pullFeature';

function repo(upstream: string | null, gone = false) {
  activeTabWith();
  useRuntime.setState({ tabs: { t: { repo: { id: 1, path: '/t' }, graph: { head: { branch: 'refs/heads/main' }, worktrees: [] }, sidebar: { locals: [{ name: 'main', fullName: 'refs/heads/main', upstream, gone, isHead: true }] } } as never } });
}

beforeEach(() => pull.mockClear());

describe('Ctrl+Shift+L: Pull', () => {
  it("pulls the checked-out branch in the Pull button's mode", () => {
    repo('refs/remotes/origin/main');
    useAppState.getState().setSettings({ syncButton: 'pullRebase' });
    expect(actionForCombo('Ctrl+Shift+L')?.id).toBe('sync.pull');
    runAction('sync.pull');
    expect(pull).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/t' }, 'rebase');
  });

  it('fast-forward if possible while the button fetches', () => {
    repo('refs/remotes/origin/main');
    useAppState.getState().setSettings({ syncButton: 'fetchAll' });
    runAction('sync.pull');
    expect(pull).toHaveBeenCalledWith(expect.anything(), 'ffOrMerge');
  });

  it('not without an upstream to pull from', () => {
    repo(null);
    expect(actionForCombo('Ctrl+Shift+L')).toBeUndefined();
    repo('refs/remotes/origin/main', true);
    expect(actionForCombo('Ctrl+Shift+L')).toBeUndefined();
  });
});
