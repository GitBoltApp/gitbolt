import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

vi.mock('../../markdown/highlightQueue', () => ({ queueHighlight: () => ({ result: Promise.resolve(null), cancel: () => {} }) }));
const api = vi.hoisted(() => ({ diffContents: vi.fn(), applySuggestion: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));

const { MdSuggestion } = await import('../../markdown/MdCode');
const { linesBase, MdSuggestionApply, MdSuggestionBase, snippetBase } = await import('../../markdown/suggestion');
const { applyControl } = await import('./ApplySuggestionButton');
const { useRuntime } = await import('../../app/runtime');
const { useTabViews } = await import('../../app/tabStores');
const { useForge } = await import('../mrStore');
const { useToast } = await import('../../ui/toastStore');
const { mrOf } = await import('../testMrs');

const HEAD = 'a'.repeat(40);
const mr = mrOf(12, { sourceBranch: 'dev', headSha: HEAD });
let changed: ((wts: ReadonlySet<string>) => void) | null = null;
const wip = { put: vi.fn(), subscribe: vi.fn((l: (wts: ReadonlySet<string>) => void) => { changed = l; return () => { changed = null; }; }) };

function tab(branch: string) {
  useRuntime.setState({ tabs: { t: { repo: { id: 4, path: '/r' }, worktree: null, info: { remotes: [] }, sidebar: null } as never } });
  const store = createStore(() => ({ repoPath: '/r', graph: { openWorktree: '/r', head: { branch, target: HEAD, detached: false, unborn: false }, worktrees: [] } }));
  useTabViews.setState({ views: { t: { repo: 4, services: { wip }, store } as never } });
}
const file = (text: string) => ({ old: null, new: { size: text.length, binary: false, encoding: 'UTF-8', eol: 'Lf', text, base64: null, hash: 'h1' }, tooLarge: false, eolOnly: false, image: false });
const result = { outcome: { hash: 'h2' }, journal: { undo: { entry: 3, label: 'apply the suggestion to src/cart.ts', kind: 'save' }, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null }, wip: null };

/** A comment on line 2 of src/cart.ts, as a card in the diff renders its suggestion. */
function suggestion(target = true) {
  const base = linesBase('gitlab', 'src/cart.ts', 2, 2, (from, to) => ['a', 'return sum;', 'b'].slice(from - 1, to));
  const body = <MdSuggestion code="return sum - discount;" lang="suggestion:-0+0" />;
  return render(<MdSuggestionBase value={base}>{target ? <MdSuggestionApply value={applyControl({ tabId: 't', kind: 'gitlab', mr })}>{body}</MdSuggestionApply> : body}</MdSuggestionBase>);
}
const button = () => screen.getByRole('button', { name: /^Apply the suggestion/ });

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  tab('refs/heads/dev');
});

describe("a suggestion's Apply", () => {
  it('applies it to the working copy, then says it is applied', async () => {
    api.diffContents.mockResolvedValue(file('a\nreturn sum;\nb\n'));
    api.applySuggestion.mockResolvedValue(result);
    suggestion();
    await waitFor(() => expect(button()).not.toHaveAttribute('aria-disabled'));
    expect(button()).toHaveAccessibleName('Apply the suggestion to src/cart.ts');
    fireEvent.click(button());
    await waitFor(() => expect(api.applySuggestion).toHaveBeenCalledWith(4, '/r', 'src/cart.ts', 'a\nreturn sum - discount;\nb\n', 'h1', { head: HEAD, refs: { 'refs/heads/dev': HEAD } }));
    // The write's fresh WIP lists: the file is read again.
    api.diffContents.mockResolvedValue(file('a\nreturn sum - discount;\nb\n'));
    act(() => changed?.(new Set(['/r'])));
    await waitFor(() => expect(button()).toHaveAccessibleName('Apply the suggestion: Already applied'));
    expect(button()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button());
    expect(api.applySuggestion).toHaveBeenCalledTimes(1);
  });

  it('checks the branch again on the click: HEAD moved since the render, nothing is written', async () => {
    api.diffContents.mockResolvedValue(file('a\nreturn sum;\nb\n'));
    suggestion();
    await waitFor(() => expect(button()).not.toHaveAttribute('aria-disabled'));
    // Moved under it, with no render since.
    const graph = (useTabViews.getState().views.t!.store.getState() as unknown as { graph: { head: { target: string } } }).graph;
    graph.head.target = 'b'.repeat(40);
    fireEvent.click(button());
    expect(useToast.getState().message).toBe("Check out dev at the MR's head to apply");
    await act(async () => {});
    expect(api.applySuggestion).not.toHaveBeenCalled();
  });

  it('reads the file once for every suggestion on it', async () => {
    api.diffContents.mockResolvedValue(file('a\nreturn sum;\nb\n'));
    suggestion();
    suggestion();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Apply the suggestion to src/cart.ts' })).toHaveLength(2));
    expect(api.diffContents).toHaveBeenCalledTimes(1);
  });

  it('is disabled, saying why, off the MR’s branch or when the lines changed', async () => {
    tab('refs/heads/main');
    const { unmount } = suggestion();
    expect(button()).toHaveAccessibleName("Apply the suggestion: Check out dev at the MR's head to apply");
    expect(api.diffContents).not.toHaveBeenCalled();
    unmount();
    tab('refs/heads/dev');
    api.diffContents.mockResolvedValue(file('a\nreturn total;\nb\n'));
    const changed = suggestion();
    await waitFor(() => expect(button()).toHaveAccessibleName('Apply the suggestion: The lines changed since; apply it by hand'));
    changed.unmount();
    // Binary, too large, gone: it can't be read as text.
    api.diffContents.mockResolvedValue({ ...file(''), new: { ...file('').new, binary: true, text: null } });
    suggestion();
    await waitFor(() => expect(button()).toHaveAccessibleName("Apply the suggestion: Can't read src/cart.ts here"));
  });

  it('is disabled for a comment on an older version, even where its snippet matches the file', async () => {
    api.diffContents.mockResolvedValue(file('a\nreturn sum;\nb\n'));
    const position = { path: 'src/cart.ts', oldPath: null, line: 2, oldLine: null, snippet: '@@ -1,2 +1,2 @@\n a\n-return 0;\n+return sum;', startLine: null, startOldLine: null, headSha: 'c'.repeat(40) };
    render(
      <MdSuggestionBase value={snippetBase('gitlab', position)}>
        <MdSuggestionApply value={applyControl({ tabId: 't', kind: 'gitlab', mr, position })}><MdSuggestion code="return sum - discount;" lang="suggestion:-0+0" /></MdSuggestionApply>
      </MdSuggestionBase>,
    );
    expect(button()).toHaveAccessibleName('Apply the suggestion: This comment is on an older version of the file');
    expect(button()).toHaveAttribute('aria-disabled', 'true');
    expect(api.diffContents).not.toHaveBeenCalled();
  });

  it('is not there without a place to apply it (the comment box’s Preview)', () => {
    suggestion(false);
    expect(screen.queryByRole('button', { name: /^Apply the suggestion/ })).toBeNull();
  });
});
