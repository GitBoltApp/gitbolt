import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// A commit clicked while a stage write is in flight must not decide from the lists about to
// change (Stage all & commit would take every file): the button waits, "Staging…".
const h = vi.hoisted(() => ({ commit: vi.fn(), stage: vi.fn() }));
vi.mock('../api/client', () => ({ api: { commit: h.commit, stage: h.stage, commitIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }) } }));
// As the real one: sends, and answers the outcome (applying the lists is the test's).
vi.mock('../write/client', () => ({ runWrite: async (_c: unknown, send: () => Promise<{ outcome?: unknown }>) => (await send()).outcome ?? null }));
vi.mock('../app/repoContext', () => ({ useRepoContext: () => ({ tabId: 't' }) }));
vi.mock('../stage/follow', () => ({ followOpenFile: vi.fn() }));
vi.mock('../repo/store', async () => {
  const { create } = await import('zustand');
  const files = (paths: string[]) => ({ status: 'ready', data: { files: paths.map((path) => ({ path, status: 'A' })) } });
  const lists = (unstaged: string[], staged: string[]) => ({ selection: { kind: 'wip', worktree: '/r' }, sections: [{ list: files(unstaged) }, { list: files(staged) }] });
  const state = create(() => ({
    repo: 1,
    repoPath: '/r',
    services: { messages: { get: vi.fn() } },
    graph: { rows: [{ wip: { worktreePath: '/r' }, parents: ['p'.repeat(40)] }] },
    indexById: new Map(),
    panel: lists(['lexer.txt', 'lexer_test.txt'], []),
  }));
  return { useRepoView: <T,>(sel: (s: ReturnType<typeof state.getState>) => T) => state(sel), testState: state, testLists: lists };
});

describe('the commit button while a stage is in flight', () => {
  it('waits ("Staging…") and then commits only what ended up staged', async () => {
    const store = (await import('../repo/store')) as unknown as { testState: { setState(p: object): void }; testLists(u: string[], s: string[]): object };
    const { CommitBox } = await import('./CommitBox');
    const { writeWipDraft } = await import('./draft');
    const { stagePaths } = await import('../stage/actions');
    writeWipDraft('/r', '/r', { summary: 'Lexer', description: '' });
    let answer!: (r: object) => void;
    h.stage.mockImplementation(() => new Promise((r) => { answer = r; }));
    h.commit.mockResolvedValue({ outcome: { oid: 'c'.repeat(40) } });
    render(<CommitBox />);
    const button = screen.getByRole('button', { name: 'Stage all & commit' });
    expect(button).not.toHaveAttribute('aria-disabled', 'true');

    // A slow stage of one file: the label stays (no layout shift), the click does nothing.
    let staged!: Promise<boolean>;
    act(() => { staged = stagePaths({ tabId: 't', repoId: 1, worktree: '/r' }, ['lexer.txt']); });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveTextContent('Stage all & commit');
    fireEvent.mouseEnter(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Staging…');
    fireEvent.mouseLeave(button);
    fireEvent.click(button);
    expect(h.commit).not.toHaveBeenCalled();

    // Answered, its lists in: lexer.txt staged, the other not. The commit takes only it.
    await act(async () => {
      store.testState.setState({ panel: store.testLists(['lexer_test.txt'], ['lexer.txt']) });
      answer({ outcome: null, wip: null });
      await staged;
    });
    expect(button).not.toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveTextContent('Commit changes to 1 file');
    fireEvent.click(button);
    await vi.waitFor(() => expect(h.commit).toHaveBeenCalled());
    expect(h.commit).toHaveBeenCalledWith(1, '/r', expect.objectContaining({ summary: 'Lexer', stageAll: false }));
  });
});
