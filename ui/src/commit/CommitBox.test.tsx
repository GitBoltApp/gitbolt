import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { commitButton } from './CommitBox';

const base = { staged: 0, unstaged: 0, conflicted: 0, amend: false, inMerge: false, summary: 'Fix x' };

describe('the commit button (spec #2 §8.1)', () => {
  it('names what it does', () => {
    expect(commitButton({ ...base, staged: 1 }).label).toBe('Commit changes to 1 file');
    expect(commitButton({ ...base, staged: 3, unstaged: 2 }).label).toBe('Commit changes to 3 files');
    expect(commitButton({ ...base, unstaged: 2 })).toMatchObject({ label: 'Stage all & commit', stageAll: true });
    expect(commitButton({ ...base, amend: true })).toMatchObject({ label: 'Amend previous commit', disabled: false, stageAll: false });
    expect(commitButton({ ...base, inMerge: true, staged: 1 }).label).toBe('Commit and merge');
    // Ux round 1: the label while the summary is empty.
    expect(commitButton({ ...base, staged: 1, summary: ' ' }).label).toBe('Type a message to commit');
    expect(commitButton({ ...base, unstaged: 2, summary: '' })).toMatchObject({ label: 'Type a message to commit', stageAll: true, disabled: true });
  });

  it('says why it is disabled', () => {
    expect(commitButton({ ...base, staged: 1, summary: '  ' }).reason).toBe('Write a commit summary');
    expect(commitButton({ ...base, staged: 1, conflicted: 2 }).reason).toBe('Resolve 2 conflicted files first');
    expect(commitButton({ ...base, staged: 1, conflicted: 1 }).reason).toBe('Resolve 1 conflicted file first');
    expect(commitButton(base)).toMatchObject({ disabled: true, reason: 'Nothing to commit' });
    expect(commitButton({ ...base, amend: true, summary: '' }).reason).toBe('Write a commit summary');
  });
});

const h = vi.hoisted(() => ({ commit: vi.fn(), runWrite: vi.fn() }));
vi.mock('../api/client', () => ({ api: { commit: h.commit, commitIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }) } }));
vi.mock('../write/client', () => ({ runWrite: h.runWrite }));
vi.mock('../app/repoContext', () => ({ useRepoContext: () => ({ tabId: 't' }) }));
vi.mock('../stage/actions', () => ({ useWipCtx: () => ({ tabId: 't', repoId: 1, worktree: '/r' }) }));
vi.mock('../repo/store', () => {
  // An unborn repo: the lone WIP row has no parents; one unstaged file.
  const state = {
    repoPath: '/r',
    services: { messages: { get: vi.fn() } },
    graph: { rows: [{ wip: { worktreePath: '/r' }, parents: [] }] },
    panel: { selection: { kind: 'wip' }, sections: [{ list: { status: 'ready', data: { files: [{ status: 'A' }] } } }, { list: { status: 'ready', data: { files: [] } } }] },
  };
  return { useRepoView: (sel: (s: typeof state) => unknown) => sel(state) };
});

describe('the commit box on an unborn branch (the first commit)', () => {
  it('commits with expect.head null, and Amend is disabled', async () => {
    const { CommitBox } = await import('./CommitBox');
    const { writeWipDraft } = await import('./draft');
    writeWipDraft('/r', '/r', { summary: 'Initial commit', description: '' });
    h.runWrite.mockImplementation(async (_c: unknown, send: () => Promise<unknown>) => { await send(); return null; });
    render(<CommitBox />);
    expect(screen.getByRole('checkbox', { name: 'Amend' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stage all & commit' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Stage all & commit' }).click();
    await vi.waitFor(() => expect(h.commit).toHaveBeenCalled());
    expect(h.commit).toHaveBeenCalledWith(1, '/r', expect.objectContaining({ amend: false, stageAll: true, expect: { head: null, refs: {} } }));
  });
});

describe('Ctrl+Enter outside the message (commit/keyActions.ts)', () => {
  it('the box lends its Commit to the active tab', async () => {
    const { CommitBox } = await import('./CommitBox');
    const { writeWipDraft } = await import('./draft');
    const { lentHandler } = await import('../app/lent');
    const { EMPTY_PROFILE, useAppState } = await import('../app/state');
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
    writeWipDraft('/r', '/r', { summary: 'From the keyboard', description: '' });
    h.commit.mockClear();
    h.runWrite.mockImplementation(async (_c: unknown, send: () => Promise<unknown>) => { await send(); return null; });
    const r = render(<CommitBox />);
    lentHandler('commit.commit')?.();
    await vi.waitFor(() => expect(h.commit).toHaveBeenCalledWith(1, '/r', expect.objectContaining({ summary: 'From the keyboard' })));
    r.unmount();
    expect(lentHandler('commit.commit')).toBeNull();
  });
});
