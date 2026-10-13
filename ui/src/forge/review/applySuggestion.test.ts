import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

const api = vi.hoisted(() => ({ diffContents: vi.fn(), applySuggestion: vi.fn(), undo: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
const undoFeature = vi.hoisted(() => ({ undo: vi.fn(async () => {}), undoFromHistory: vi.fn(async () => {}) }));
vi.mock('../../undo/feature', () => undoFeature);

const { ALREADY_APPLIED, LINES_CHANGED, OLDER_VERSION, applyCheck, applyGate, applySuggestion, checkOutFirst, replaceLines, saveFirst } = await import('./applySuggestion');
const { suggestedLines } = await import('../../markdown/suggestion');
const { useRuntime } = await import('../../app/runtime');
const { useTabViews } = await import('../../app/tabStores');
const { useWorkingCopy } = await import('../../diff/workingCopy');
const { patchForge, useForge } = await import('../mrStore');
const { useJournal } = await import('../../undo/store');
const { useToast } = await import('../../ui/toastStore');
const { mrOf, projectOf } = await import('../testMrs');

const HEAD = 'a'.repeat(40);
const mr = mrOf(12, { sourceBranch: 'dev', headSha: HEAD });
const EXPECT = { head: HEAD, refs: { 'refs/heads/dev': HEAD } };
const wip = { put: vi.fn(), subscribe: vi.fn(() => () => {}) };

/** Tab `t`: repo 4 at /r, its worktree on `branch` at `head`, with these local branches. */
function tab(branch: string | null, head: string | null, locals: Array<{ name: string; upstream: string | null }> = []) {
  const info = { remotes: [{ name: 'origin', url: 'x', host: 'gitlab.example.com', path: 'group/project', hostKind: 'gitlab' }, { name: 'alice', url: 'y', host: 'gitlab.example.com', path: 'alice/project', hostKind: 'gitlab' }] };
  useRuntime.setState({ tabs: { t: { repo: { id: 4, path: '/r' }, worktree: null, info, sidebar: { locals, remotes: [], worktrees: [], stashes: [], tags: [] } } as never } });
  const store = createStore(() => ({ repoPath: '/r', graph: { openWorktree: '/r', head: { branch, target: head, detached: branch === null, unborn: false }, worktrees: [{ path: '/r', branch, head, isMain: true, locked: false, inProgress: null }] } }));
  useTabViews.setState({ views: { t: { repo: 4, services: { wip }, store } as never } });
}

const result = (entry: number) => ({ outcome: { hash: 'h2' }, journal: { undo: { entry, label: 'apply the suggestion to src/cart.ts', kind: 'save' }, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null }, wip: null });
const file = (text: string) => ({ old: null, new: { size: text.length, binary: false, encoding: 'UTF-8', eol: 'Lf', text, base64: null, hash: 'h1' }, tooLarge: false, eolOnly: false, image: false });

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', project: projectOf() });
  useWorkingCopy.setState({ copies: {}, epoch: {} });
  useToast.getState().dismiss();
  tab('refs/heads/dev', HEAD);
});

describe('replaceLines', () => {
  it('replaces the range, more or fewer lines, keeping the rest', () => {
    expect(replaceLines('a\nb\nc\nd\n', 2, 2, ['B', 'C', 'X'])).toBe('a\nB\nC\nX\nd\n');
    expect(replaceLines('a\nb\nc\n', 1, 3, ['z'])).toBe('z\n');
    expect(replaceLines('a\nb\n', 2, 1, ['b2'])).toBe('a\nb2\n');
  });
  it("keeps CRLF line endings, the new lines' too", () => {
    expect(replaceLines('a\r\nb\r\nc\r\n', 2, 1, ['x', 'y'])).toBe('a\r\nx\r\ny\r\nc\r\n');
    expect(replaceLines('a\r\nb', 2, 1, ['x', 'y'])).toBe('a\r\nx\r\ny');
  });
  it('keeps a file without a final newline without one', () => {
    expect(replaceLines('a\nb', 2, 1, ['x'])).toBe('a\nx');
    expect(replaceLines('a\nb', 1, 2, ['x', 'y', 'z'])).toBe('x\ny\nz');
  });
  it('takes the lines out for an empty suggestion', () => {
    expect(replaceLines('a\nb\nc\n', 2, 1, [])).toBe('a\nc\n');
    expect(replaceLines('a\nb\nc', 3, 1, [])).toBe('a\nb');
    expect(replaceLines('a\nb\n', 1, 2, [])).toBe('');
  });
  it('gives null for a range that isn’t there', () => {
    expect(replaceLines('a\nb\n', 2, 2, ['x'])).toBeNull();
    expect(replaceLines('a\n', 0, 1, ['x'])).toBeNull();
  });
  it("reads a suggestion's lines: none for an empty one", () => {
    expect(suggestedLines('')).toEqual([]);
    expect(suggestedLines('x\r\n  y')).toEqual(['x', '  y']);
  });
});

describe('applyCheck: the replaced lines must still be at their place', () => {
  const text = 'one\ntwo\nthree\nfour\n';
  it('applies over unchanged lines, edits elsewhere in the file included', () => {
    expect(applyCheck(text, 2, ['two', 'three'], ['2', '3'])).toBeNull();
    expect(applyCheck('ONE\ntwo\nthree\nfour edited', 2, ['two', 'three'], ['2'])).toBeNull();
    expect(applyCheck('one\r\ntwo\r\n', 2, ['two'], ['2'])).toBeNull();
  });
  it('refuses an edit inside the range, or a moved range', () => {
    expect(applyCheck('one\ntwo!\nthree\n', 2, ['two', 'three'], ['2'])).toBe(LINES_CHANGED);
    expect(applyCheck(`zero\n${text}`, 2, ['two', 'three'], ['2'])).toBe(LINES_CHANGED);
    expect(applyCheck(text, 9, ['two'], ['2'])).toBe(LINES_CHANGED);
  });
  it('knows a suggestion already applied', () => {
    expect(applyCheck('one\n2\n3\nfour\n', 2, ['two', 'three'], ['2', '3'])).toBe(ALREADY_APPLIED);
    expect(applyCheck(text, 2, ['two'], ['two'])).toBe(ALREADY_APPLIED);
    expect(applyCheck('one\nTWO\n', 2, ['two'], ['two'])).toBe(LINES_CHANGED);
    // Lines added after the replaced ones: the replaced lines are still there once it's in.
    expect(applyCheck('foo();\nx\n', 1, ['foo();'], ['foo();', 'bar();'])).toBeNull();
    expect(applyCheck('foo();\nbar();\nx\n', 1, ['foo();'], ['foo();', 'bar();'])).toBe(ALREADY_APPLIED);
    // Lines taken off the end: the suggested ones are there before it's in.
    expect(applyCheck('a\nb\nc\n', 1, ['a', 'b'], ['a'])).toBeNull();
    // A duplicate line deleted looks the same after: only the bytes it wrote say it's in.
    expect(applyCheck('a\nx\nb\n', 2, ['x'], [])).toBeNull();
    expect(applyCheck('a\nx\nb\n', 2, ['x'], [], true)).toBe(ALREADY_APPLIED);
  });
});

describe('applyGate: the MR checked out at its head', () => {
  it("writes to the tab's worktree on the MR's branch at its head", () => {
    expect(applyGate('t', 'gitlab', mr, HEAD, 'src/cart.ts')).toEqual({ ctx: { tabId: 't', repoId: 4, worktree: '/r' }, expect: EXPECT });
  });
  it('refuses another branch, another commit, a detached HEAD or an unknown head', () => {
    const why = { reason: checkOutFirst('gitlab', mr) };
    expect(why.reason).toBe("Check out dev at the MR's head to apply");
    expect(checkOutFirst('github', mr)).toBe("Check out dev at the PR's head to apply");
    tab('refs/heads/main', HEAD);
    expect(applyGate('t', 'gitlab', mr, HEAD, 'a')).toEqual(why);
    tab('refs/heads/dev', 'b'.repeat(40));
    expect(applyGate('t', 'gitlab', mr, HEAD, 'a')).toEqual(why);
    tab(null, HEAD);
    expect(applyGate('t', 'gitlab', mr, HEAD, 'a')).toEqual(why);
    tab('refs/heads/dev', HEAD);
    expect(applyGate('t', 'gitlab', mr, null, 'a')).toEqual(why);
  });
  it("takes a fork's branch checked out under another name, tracking the fork's", () => {
    const fork = mrOf(13, { sourceProject: 'alice/project', sourceBranch: 'dev', headSha: HEAD });
    tab('refs/heads/alice-dev', HEAD, [{ name: 'alice-dev', upstream: 'refs/remotes/alice/dev' }]);
    expect(applyGate('t', 'gitlab', fork, HEAD, 'a')).toHaveProperty('ctx');
    tab('refs/heads/alice-dev', HEAD, [{ name: 'alice-dev', upstream: 'refs/remotes/origin/dev' }]);
    expect(applyGate('t', 'gitlab', fork, HEAD, 'a')).toEqual({ reason: checkOutFirst('gitlab', fork) });
  });
  it('refuses a comment on an older version of the file: GitHub’s outdated, GitLab’s other head', () => {
    const at = { path: 'a', oldPath: null, line: 2, oldLine: null, snippet: null, startLine: null, startOldLine: null };
    expect(applyGate('t', 'github', mr, HEAD, 'a', { ...at, outdated: true })).toEqual({ reason: OLDER_VERSION });
    expect(applyGate('t', 'gitlab', mr, HEAD, 'a', { ...at, headSha: 'c'.repeat(40) })).toEqual({ reason: OLDER_VERSION });
    expect(applyGate('t', 'gitlab', mr, HEAD, 'a', { ...at, headSha: HEAD })).toHaveProperty('ctx');
    expect(applyGate('t', 'gitlab', mr, HEAD, 'a', at)).toHaveProperty('ctx');
  });
  it('waits for unsaved edits to the same file in the editor to be saved', () => {
    useWorkingCopy.setState({ copies: { t: { key: 'k', path: 'src/cart.ts', worktree: '/r', repo: 4, base: 'h1', dirty: true } } });
    expect(applyGate('t', 'gitlab', mr, HEAD, 'src/cart.ts')).toEqual({ reason: saveFirst('src/cart.ts') });
    expect(applyGate('t', 'gitlab', mr, HEAD, 'src/other.ts')).toHaveProperty('ctx');
  });
});

describe('applySuggestion', () => {
  const ctx = { tabId: 't', repoId: 4, worktree: '/r' };
  const at = { ctx, expect: EXPECT };
  it('writes the file with the lines replaced, behind the read base and HEAD at the MR’s head, and offers Undo', async () => {
    api.diffContents.mockResolvedValue(file('a\nreturn sum;\nb\n'));
    api.applySuggestion.mockResolvedValue(result(7));
    expect(await applySuggestion(at, 'src/cart.ts', 2, ['return sum;'], ['return sum - discount;'])).toBe(true);
    expect(api.diffContents).toHaveBeenCalledWith(4, { path: 'src/cart.ts', old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, force: false });
    expect(api.applySuggestion).toHaveBeenCalledWith(4, '/r', 'src/cart.ts', 'a\nreturn sum - discount;\nb\n', 'h1', EXPECT);
    const toast = useToast.getState();
    expect(toast.message).toBe('Applied the suggestion to src/cart.ts');
    expect(toast.action?.label).toBe('Undo');
    // Still on top: the toolbar's Undo; something done since: out of order.
    toast.action!.run();
    await vi.waitFor(() => expect(undoFeature.undo).toHaveBeenCalledWith(ctx));
    useJournal.getState().set(4, '/r', result(9).journal as never);
    toast.action!.run();
    await vi.waitFor(() => expect(undoFeature.undoFromHistory).toHaveBeenCalledWith(ctx, expect.objectContaining({ entry: 7, touched: ['src/cart.ts'] })));
  });
  it('applies an added line, or a deleted duplicate, once', async () => {
    const twice = async (path: string, before: string, after: string, from: number, replaced: string[], suggested: string[]) => {
      api.diffContents.mockResolvedValueOnce({ ...file(before), new: { ...file(before).new, hash: `${path}-1` } });
      api.applySuggestion.mockResolvedValueOnce({ ...result(7), outcome: { hash: `${path}-2` } });
      expect(await applySuggestion(at, path, from, replaced, suggested)).toBe(true);
      expect(api.applySuggestion).toHaveBeenLastCalledWith(4, '/r', path, after, `${path}-1`, EXPECT);
      api.diffContents.mockResolvedValueOnce({ ...file(after), new: { ...file(after).new, hash: `${path}-2` } });
      expect(await applySuggestion(at, path, from, replaced, suggested)).toBe(false);
      expect(useToast.getState().message).toBe(ALREADY_APPLIED);
    };
    await twice('append.ts', 'foo();\nx\n', 'foo();\nbar();\nx\n', 1, ['foo();'], ['foo();', 'bar();']);
    await twice('dup.ts', 'a\nx\nx\nb\n', 'a\nx\nb\n', 2, ['x'], []);
    expect(api.applySuggestion).toHaveBeenCalledTimes(2);
  });
  it('writes nothing when the lines changed since the button was enabled', async () => {
    api.diffContents.mockResolvedValue(file('a\nreturn total;\nb\n'));
    expect(await applySuggestion(at, 'src/cart.ts', 2, ['return sum;'], ['x'])).toBe(false);
    expect(api.applySuggestion).not.toHaveBeenCalled();
    expect(useToast.getState().message).toBe(LINES_CHANGED);
  });
  it("refuses a file it can't edit as text", async () => {
    api.diffContents.mockResolvedValue({ ...file('a\n'), new: { ...file('a\n').new, filtered: true } });
    expect(await applySuggestion(at, 'a', 1, ['a'], ['b'])).toBe(false);
    expect(useToast.getState().message).toBe("Can't read a here");
    api.diffContents.mockRejectedValue(new Error('gone'));
    expect(await applySuggestion(at, 'gone.ts', 1, ['a'], ['b'])).toBe(false);
    expect(useToast.getState().message).toBe("Can't read gone.ts here");
    expect(api.applySuggestion).not.toHaveBeenCalled();
  });
});
