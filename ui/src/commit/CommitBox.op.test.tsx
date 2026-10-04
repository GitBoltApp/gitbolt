import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InProgress } from '../api/gen/InProgress';

// Ux round 1: an operation in progress lives in the commit panel, not a window-wide bar.
const h = vi.hoisted(() => ({
  inProgress: null as unknown,
  identity: { name: 'Ada Lovelace', email: 'ada@example.com' } as unknown,
  unstaged: [] as { status: string; path?: string }[],
  headParents: ['o'],
  head: 'p',
  staged: [] as { status: string }[],
  rebaseControl: vi.fn(async () => ({})),
  pickControl: vi.fn(async () => ({})),
  mergeAbort: vi.fn(async () => ({})),
  commit: vi.fn(async () => ({})),
  cancelOp: vi.fn(async () => null),
  // Abort arms in place first (spec §ui confirms, board D): answered yes here.
  confirm: vi.fn(async (_r: { arm: string }) => true),
}));
vi.mock('../api/client', () => ({
  api: { rebaseControl: h.rebaseControl, pickControl: h.pickControl, mergeAbort: h.mergeAbort, commit: h.commit, cancelOp: h.cancelOp, commitIdentity: async () => h.identity },
}));
vi.mock('../write/client', () => ({
  runWrite: async (_c: unknown, send: () => Promise<unknown>, opts: { onSuccess?: (o: unknown) => Promise<void> } = {}) => {
    const out = await send();
    await opts.onSuccess?.({ oid: 'n' });
    return out;
  },
}));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: h.confirm }));
vi.mock('../app/repoContext', () => ({ useRepoContext: () => ({ tabId: 't' }) }));
vi.mock('../app/graphNav', () => ({ selectCommit: vi.fn() }));
vi.mock('../stage/actions', () => ({ useWipCtx: () => ({ tabId: 't', repoId: 1, worktree: '/r' }) }));
vi.mock('../repo/store', () => ({
  useRepoView: (sel: (s: unknown) => unknown) =>
    sel({
      repoPath: '/r',
      services: { messages: { get: vi.fn(async () => ({ summary: 'From the commit', body: '' })) } },
      graph: { rows: [{ id: 'wip:/r', wip: { worktreePath: '/r' }, parents: [h.head] }, { id: 'p', parents: h.headParents }], labels: [], inProgress: { '/r': h.inProgress }, worktrees: [{ path: '/r', branch: null }] },
      indexById: new Map([['wip:/r', 0], ['p', 1]]),
      panel: { selection: { kind: 'wip' }, sections: [{ list: { status: 'ready', data: { files: h.unstaged } } }, { list: { status: 'ready', data: { files: h.staged } } }] },
    }),
}));

const rebase = (conflicted: number, message = 'Fix x\n\nWhy.\n\n# Conflicts:\n#\tc.txt\n'): InProgress => ({ kind: 'rebase', onto: 'b'.repeat(40), headName: 'refs/heads/feature/x', step: 1, total: 1, stoppedAt: 'a'.repeat(40), editStop: null, editBase: null, editAdded: [], editChanged: false, editConflict: false, messageFailed: null, gitbolt: true, conflicted, message });

async function show() {
  const { CommitBox } = await import('./CommitBox');
  return render(<CommitBox />);
}

describe('the commit box in an operation', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.clearAllMocks();
    h.unstaged = [];
    h.headParents = ['o'];
    h.head = 'p';
    h.staged = [];
    h.identity = { name: 'Ada Lovelace', email: 'ada@example.com' };
    const { useCommitBox } = await import('./store');
    useCommitBox.setState({ op: {}, amend: {} });
  });

  it('a stopped rebase: its status, its message prefilled, Continue gated while conflicts remain', async () => {
    h.inProgress = rebase(1);
    h.unstaged = [{ status: 'U' }];
    await show();
    const status = screen.getByRole('region', { name: 'Rebase in progress' });
    expect(status).toHaveTextContent('Rebasing feature/x onto bbbbbbb (step 1 of 1)');
    expect(status).toHaveTextContent('Resolve 1 conflicted file first');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('Fix x'));
    expect(screen.getByRole('textbox', { name: 'Commit description' })).toHaveValue('Why.');
    expect(screen.queryByRole('checkbox', { name: 'Amend' })).toBeNull();
    const cont = screen.getByRole('button', { name: 'Continue rebase' });
    expect(cont).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(cont);
    expect(h.rebaseControl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(h.rebaseControl).toHaveBeenCalledWith(1, '/r', 'skip'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase' }));
    expect(h.confirm.mock.lastCall?.[0]).toMatchObject({ arm: 'Click again to abort the rebase', danger: true });
    await waitFor(() => expect(h.rebaseControl).toHaveBeenCalledWith(1, '/r', 'abort'));
  });

  it('an unedited Continue sends no message: git keeps its own text (review 1)', async () => {
    h.inProgress = rebase(0, 'Fix x\nwrapped subject\n\n#12 body\n');
    await show();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('Fix x'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue rebase' }));
    await waitFor(() => expect(h.rebaseControl).toHaveBeenCalledWith(1, '/r', 'continue', undefined));
  });

  it('a description with no summary waits for one, not silently dropped (review 6)', async () => {
    h.inProgress = rebase(0);
    await show();
    const summary = screen.getByRole('textbox', { name: 'Commit summary' });
    await waitFor(() => expect(summary).toHaveValue('Fix x'));
    fireEvent.change(summary, { target: { value: '' } });
    const cont = screen.getByRole('button', { name: 'Continue rebase' });
    expect(cont).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(cont);
    expect(h.rebaseControl).not.toHaveBeenCalled();
  });

  it('Skip is gated while one runs: a double click skips one commit (review 4)', async () => {
    h.inProgress = { kind: 'cherryPick', head: 'd'.repeat(40), message: 'Pick me\n', conflicted: 0 } satisfies InProgress;
    let release = () => {};
    h.pickControl.mockImplementationOnce(() => new Promise((r) => { release = () => r({}); }));
    await show();
    const skip = screen.getByRole('button', { name: 'Skip' });
    fireEvent.click(skip);
    fireEvent.click(skip);
    fireEvent.click(screen.getByRole('button', { name: 'Abort cherry-pick' }));
    expect(h.pickControl).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(skip).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(skip);
    await waitFor(() => expect(h.pickControl).toHaveBeenCalledTimes(2));
  });

  it('a Continue still running after 30 s says so, and Cancel stops that write (UX F: a signer waiting on nobody)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release = () => {};
    try {
      h.inProgress = rebase(0);
      h.rebaseControl.mockImplementationOnce(() => new Promise((r) => { release = () => r({}); }));
      const { useOps } = await import('../app/ops');
      const op = (id: number, kind: 'rebase' | 'stage', label: string) => ({ op: id, kind, repo: 1, label, phase: null, percent: null, interactive: true, shown: false, startedAt: Date.now() });
      // Fix round 1: another write already running (the stage of a file) is never the box's.
      useOps.setState({ ops: { 3: op(3, 'stage', 'stage a.txt') } });
      await show();
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('Fix x'));
      fireEvent.click(screen.getByRole('button', { name: 'Continue rebase' }));
      await waitFor(() => expect(h.rebaseControl).toHaveBeenCalled());
      // The box's write starts (`opStarted`), then another one queued after it.
      useOps.setState({ ops: { 3: op(3, 'stage', 'stage a.txt'), 7: op(7, 'rebase', 'continue the rebase') } });
      useOps.setState({ ops: { 3: op(3, 'stage', 'stage a.txt'), 7: op(7, 'rebase', 'continue the rebase'), 9: op(9, 'stage', 'stage b.txt') } });
      await act(() => vi.advanceTimersByTimeAsync(29_000));
      expect(screen.queryByText('Still working…')).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1_500));
      expect(screen.getByTestId('commit-still')).toHaveTextContent('Still working…');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(h.cancelOp.mock.calls).toEqual([[7]]);
      // Its op gone (the others still running): no Cancel for anyone else's.
      act(() => useOps.setState({ ops: { 3: op(3, 'stage', 'stage a.txt'), 9: op(9, 'stage', 'stage b.txt') } }));
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      release();
      await waitFor(() => expect(screen.queryByTestId('commit-still')).toBeNull());
    } finally {
      release();
      vi.useRealTimers();
      const { useOps } = await import('../app/ops');
      useOps.setState({ ops: {} });
    }
  });

  it('Continue sends the message as edited', async () => {
    h.inProgress = rebase(0);
    await show();
    const summary = screen.getByRole('textbox', { name: 'Commit summary' });
    await waitFor(() => expect(summary).toHaveValue('Fix x'));
    fireEvent.change(summary, { target: { value: 'Fix x, reworded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue rebase' }));
    await waitFor(() => expect(h.rebaseControl).toHaveBeenCalledWith(1, '/r', 'continue', 'Fix x, reworded\n\nWhy.'));
  });

  it('git wrote no message: the stopped commit\'s fills the box', async () => {
    h.inProgress = rebase(0, '');
    await show();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('From the commit'));
  });

  it('a cherry-pick: Continue cherry-pick, through its own control', async () => {
    h.inProgress = { kind: 'cherryPick', head: 'd'.repeat(40), message: 'Pick me\n', conflicted: 0 } satisfies InProgress;
    await show();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('Pick me'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue cherry-pick' }));
    await waitFor(() => expect(h.pickControl).toHaveBeenCalledWith(1, '/r', 'continue', undefined));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Abort cherry-pick' }));
    await waitFor(() => expect(h.pickControl).toHaveBeenCalledWith(1, '/r', 'abort'));
  });

  it('a merge: Commit and merge with the WIP draft; Abort puts the pre-merge draft back', async () => {
    const { writeWipDraft, readWipDraft } = await import('./draft');
    const { applyMergeDraft } = await import('../conflicts/mergeDraft');
    writeWipDraft('/r', '/r', { summary: 'Mine', description: '' });
    applyMergeDraft('/r', '/r', "Merge branch 'feature/x'\n", 'f'.repeat(40));
    h.inProgress = { kind: 'merge', mergeHead: 'f'.repeat(40), message: "Merge branch 'feature/x'\n", conflicted: 0 } satisfies InProgress;
    await show();
    expect(screen.getByRole('region', { name: 'Merge in progress' })).toHaveTextContent('No conflicted files left: commit to finish the merge.');
    expect(screen.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('Mine');
    expect(screen.getByRole('button', { name: 'Commit and merge' })).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Abort merge' }));
    await waitFor(() => expect(h.mergeAbort).toHaveBeenCalledWith(1, '/r'));
    await waitFor(() => expect(readWipDraft('/r', '/r')).toEqual({ summary: 'Mine', description: '' }));
  });

  // --- 3C T13, UX L ---
  /** git's own Edit stop (no soft reset): `at` is the commit git made. */
  const editStop = (at: string): InProgress => ({ ...rebase(0, 'Fix x\n\nWhy.\n'), editStop: at } as InProgress);
  /** UX L: GitBolt's Edit stop, "about to commit": HEAD went back to `base`, the commit's parent. */
  const aboutToCommit = (at: string, base: string): InProgress => ({ ...editStop(at), editBase: base } as InProgress);

  it('an Edit stop about to commit: the notice, the commit\'s message in the box, Commit and Continue, no Skip (UX L)', async () => {
    h.inProgress = aboutToCommit('q', 'p');
    h.staged = [{ status: 'A' }, { status: 'A' }];
    await show();
    expect(screen.getByRole('region', { name: 'Rebase in progress' })).toHaveTextContent('Editing q Fix x: its changes are staged. Change them, commit in pieces, or just Continue.');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('Fix x'));
    expect(screen.getByRole('textbox', { name: 'Commit description' })).toHaveValue('Why.');
    expect(document.querySelector('.commit-button')).toHaveTextContent('Commit changes to 2 files');
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Split this commit' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Amend' })).toBeNull();
    const cont = screen.getByRole('button', { name: 'Continue rebase' });
    expect(cont).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit summary' }), { target: { value: 'Fix x, reworded' } });
    fireEvent.click(cont);
    await waitFor(() => expect(h.rebaseControl).toHaveBeenCalledWith(1, '/r', 'continue', 'Fix x, reworded\n\nWhy.'));
  });

  it('an unedited box: Continue sends no message, so the core keeps the commit as it is, even a first paragraph of two lines (fix round 1)', async () => {
    h.inProgress = { ...aboutToCommit('q', 'p'), message: 'Fix x\nacross two lines\n\nWhy.\n' } as InProgress;
    h.staged = [{ status: 'A' }];
    await show();
    expect(screen.getByRole('region', { name: 'Rebase in progress' })).toHaveTextContent('Amending in a terminal here would fold this commit into its parent.');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit summary' })).not.toHaveValue(''));
    fireEvent.click(screen.getByRole('button', { name: 'Continue rebase' }));
    await waitFor(() => expect(h.rebaseControl).toHaveBeenCalledWith(1, '/r', 'continue'));
  });

  it('a file the commit adds, left untracked, holds Continue up by name; another untracked file doesn\'t (fix round 1)', async () => {
    h.inProgress = { ...aboutToCommit('q', 'p'), editAdded: ['a.txt', 'b.txt'] } as InProgress;
    h.staged = [{ status: 'A' }];
    h.unstaged = [{ path: '.env', status: 'A' }, { path: 'b.txt', status: 'A' }];
    const { rerender } = await show();
    const cont = () => screen.getByRole('button', { name: 'Continue rebase' });
    expect(cont()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.mouseEnter(cont());
    expect(screen.getByRole('tooltip')).toHaveTextContent("b.txt from this commit isn't staged. Stage it, or discard it, then Continue.");
    fireEvent.mouseLeave(cont());
    h.unstaged = [{ path: '.env', status: 'A' }];
    const { CommitBox } = await import('./CommitBox');
    rerender(<CommitBox />);
    expect(cont()).not.toHaveAttribute('aria-disabled', 'true');
    // Only the user's own untracked file: Abort keeps nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase' }));
    expect(h.confirm.mock.lastCall?.[0].arm).toBe('Click again to abort the rebase');
  });

  it('staged changes that differ from the commit: Abort says the work is kept (fix round 1)', async () => {
    h.inProgress = { ...aboutToCommit('q', 'p'), editChanged: true } as InProgress;
    h.staged = [{ status: 'M' }];
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase' }));
    expect(h.confirm.mock.lastCall?.[0].arm).toBe('Click again to abort: new work from the stop is kept');
  });

  it('a Commit at the stop is a piece: the WIP stays selected, the box empties, the rebase stays stopped (UX L)', async () => {
    const { selectCommit } = await import('../app/graphNav');
    h.inProgress = aboutToCommit('q', 'p');
    h.staged = [{ status: 'A' }];
    h.unstaged = [{ status: '?' }];
    await show();
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit summary' }), { target: { value: 'Lexer' } });
    fireEvent.click(document.querySelector('.commit-button')!);
    await waitFor(() => expect(h.commit).toHaveBeenCalledWith(1, '/r', expect.objectContaining({ summary: 'Lexer', stageAll: false })));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit summary' })).toHaveValue(''));
    expect(selectCommit).not.toHaveBeenCalled();
    expect(h.rebaseControl).not.toHaveBeenCalled();
  });

  it('changes left unstaged: Continue waits, "Commit or discard your changes first"; an empty summary over staged changes waits too (UX L)', async () => {
    h.inProgress = aboutToCommit('q', 'p');
    h.unstaged = [{ status: 'M' }];
    const { rerender } = await show();
    const cont = screen.getByRole('button', { name: 'Continue rebase' });
    expect(cont).toHaveAttribute('aria-disabled', 'true');
    fireEvent.mouseEnter(cont);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Commit or discard your changes first');
    fireEvent.mouseLeave(cont);
    fireEvent.click(cont);
    h.unstaged = [];
    h.staged = [{ status: 'M' }];
    const { CommitBox } = await import('./CommitBox');
    rerender(<CommitBox />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit summary' }), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Continue rebase' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Continue rebase' }));
    expect(h.rebaseControl).not.toHaveBeenCalled();
  });

  it('every change committed in pieces: Continue just goes on, and Amend is back for the last piece (UX L)', async () => {
    h.inProgress = aboutToCommit('q', 'p');
    h.head = 'n'; // a piece committed on top of the commit's parent `p`
    await show();
    expect(screen.getByRole('checkbox', { name: 'Amend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue rebase' }));
    await waitFor(() => expect(h.rebaseControl).toHaveBeenCalledWith(1, '/r', 'continue'));
  });

  it('what Abort says it keeps at the stop: nothing as it was, the pieces on a branch, changes left as work (UX L)', async () => {
    h.inProgress = aboutToCommit('q', 'p');
    h.staged = [{ status: 'A' }];
    const { rerender } = await show();
    const { CommitBox } = await import('./CommitBox');
    const abortSays = async () => {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Abort rebase' })).not.toHaveAttribute('aria-disabled', 'true'));
      fireEvent.click(screen.getByRole('button', { name: 'Abort rebase' }));
      await waitFor(() => expect(h.rebaseControl).toHaveBeenCalledTimes(h.confirm.mock.calls.length));
      return h.confirm.mock.lastCall?.[0].arm;
    };
    expect(await abortSays()).toBe('Click again to abort the rebase');
    h.head = 'n';
    rerender(<CommitBox />);
    expect(await abortSays()).toBe('Click again to abort: new commits from the stop are kept on a branch');
    h.unstaged = [{ status: 'M' }];
    rerender(<CommitBox />);
    expect(await abortSays()).toBe('Click again to abort: new work from the stop is kept');
  });

  it('git\'s own Edit stop HEAD has left: a normal commit box, and Continue waits for the changes to be committed', async () => {
    h.inProgress = editStop('q');
    h.unstaged = [{ status: 'M' }];
    await show();
    expect(screen.getByRole('checkbox', { name: 'Amend' })).toBeTruthy();
    const cont = screen.getByRole('button', { name: 'Continue rebase' });
    expect(cont).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit summary' }), { target: { value: 'Lexer' } });
    expect(document.querySelector('.commit-button')).toHaveTextContent('Stage all & commit');
    fireEvent.click(document.querySelector('.commit-button')!);
    await waitFor(() => expect(h.commit).toHaveBeenCalled());
  });

  it('a commit at an Edit stop HEAD has left keeps the WIP selected; with no operation, it selects the new commit (T14)', async () => {
    const { selectCommit } = await import('../app/graphNav');
    h.inProgress = editStop('q');
    h.unstaged = [{ status: 'M' }];
    const { unmount } = await show();
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit summary' }), { target: { value: 'Lexer' } });
    fireEvent.click(document.querySelector('.commit-button')!);
    await waitFor(() => expect(h.commit).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(selectCommit).not.toHaveBeenCalled();
    unmount();
    h.inProgress = null;
    await show();
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit summary' }), { target: { value: 'Plain' } });
    fireEvent.click(document.querySelector('.commit-button')!);
    await waitFor(() => expect(selectCommit).toHaveBeenCalledWith('t', 'n'));
  });

  it('an Edit stop HEAD has left, all committed: Continue rebase goes on; Abort says the work is kept and where', async () => {
    h.inProgress = editStop('q');
    h.rebaseControl.mockImplementationOnce(async () => ({ status: 'done', commits: 2, fastForward: false, warning: "feature/a wasn't deleted: it changed during the rebase" }));
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Continue rebase' }));
    await waitFor(() => expect(h.rebaseControl).toHaveBeenCalledWith(1, '/r', 'continue'));
    const { useToast } = await import('../ui/toast');
    await waitFor(() => expect(useToast.getState()).toMatchObject({ message: "feature/a wasn't deleted: it changed during the rebase", tone: 'warning' }));
    h.rebaseControl.mockImplementationOnce(async () => ({ status: 'aborted', stash: 's'.repeat(40), branch: 'feature/x-rebase-work' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Abort rebase' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase' }));
    expect(h.confirm.mock.lastCall?.[0]).toMatchObject({ arm: 'Click again to abort: new work from the stop is kept' });
    // The stash has the core's own banner (fix 1 M4): the toast names the branch only, a timed
    // warning (final fix M3).
    await waitFor(() => expect(useToast.getState()).toMatchObject({ message: 'Your commits from the stop are on feature/x-rebase-work', sticky: false, tone: 'warning' }));
  });

  it('a conflict stop: Abort keeps hand-made changes in GitBolt\'s rebase (its journal session), discards the resolution otherwise (fix 1 M5, UX N)', async () => {
    h.inProgress = rebase(1);
    h.unstaged = [{ status: 'U' }];
    h.staged = [{ status: 'M' }];
    const { useJournal, journalKey } = await import('../undo/store');
    const paused = { entry: 1, kind: 'rebase' as const, label: 'rebase feature/x', target: 'main', irebase: true };
    useJournal.setState({ states: { [journalKey(1, '/r')]: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused } } });
    const { rerender } = await show();
    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase' }));
    expect(h.confirm.mock.lastCall?.[0]).toMatchObject({ arm: 'Click again to abort: changes you made by hand are kept' });
    useJournal.setState({ states: { [journalKey(1, '/r')]: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: { ...paused, irebase: false } } } });
    const { CommitBox } = await import('./CommitBox');
    rerender(<CommitBox />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Abort rebase' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase' }));
    expect(h.confirm.mock.lastCall?.[0]).toMatchObject({ arm: 'Click again to abort: discards the conflict resolution so far' });
    useJournal.setState({ states: {} });
  });

  it('an Edit stop of a rebase started in a terminal: no Commit, the box stays Continue\'s (fix 1 A1; UX L leaves it git\'s)', async () => {
    h.inProgress = { ...editStop('p'), gitbolt: false } as InProgress;
    const { rerender } = await show();
    expect(screen.getByRole('region', { name: 'Rebase in progress' })).toHaveTextContent('Finish this rebase where you started it.');
    const { CommitBox } = await import('./CommitBox');
    h.head = 'o';
    h.unstaged = [{ status: 'M' }];
    rerender(<CommitBox />);
    expect(document.querySelector('.commit-button')).toHaveTextContent('Continue rebase');
    expect(screen.queryByRole('checkbox', { name: 'Amend' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Continue rebase' })).toHaveLength(1);
  });
  // --- end 3C T13, UX L ---
});

describe('the commit identity line', () => {
  beforeEach(() => {
    h.inProgress = null;
    h.unstaged = [{ status: 'M' }];
  });

  it('names who the commit is made as', async () => {
    h.identity = { name: 'Ada Lovelace', email: 'ada@example.com' };
    await show();
    await waitFor(() => expect(screen.getByTestId('commit-identity')).toHaveTextContent('Ada Lovelace'));
    expect(screen.getByTestId('commit-identity')).toHaveTextContent('ada@example.com');
  });

  it('warns when git has none', async () => {
    h.identity = null;
    await show();
    await waitFor(() => expect(screen.getByTestId('commit-identity')).toHaveTextContent('No git identity set: commits will fail'));
  });
});
