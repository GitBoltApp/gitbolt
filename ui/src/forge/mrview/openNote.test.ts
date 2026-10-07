import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffPosition } from '../../api/gen/DiffPosition';

const api = vi.hoisted(() => ({ mergeBase: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: String }));
const view = vi.hoisted(() => ({
  compareCommits: vi.fn(() => true),
  openFile: vi.fn(),
  files: [] as Array<{ path: string; oldPath: string | null }>,
}));
vi.mock('../../app/tabStores', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/tabStores')>()),
  tabStore: () => ({ getState: () => ({ compareCommits: view.compareCommits, openFile: view.openFile, services: { files: { get: async () => ({ files: view.files.map((f) => ({ ...f, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false })) }) } } }) }),
}));

const { openNoteFile } = await import('./openNote');
const { noteLine, noteWhere } = await import('./noteLine');
const { patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toast');
const { mrOf } = await import('../testMrs');

const B = 'b'.repeat(40);
const MAIN = 'm'.repeat(40);
const mr = mrOf(12);
const at = (path: string, line: number | null = 3, oldLine: number | null = null, startLine: number | null = null, startOldLine: number | null = null): DiffPosition => ({ path, oldPath: null, line, oldLine, snippet: null, startLine, startOldLine });

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin' });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 }, sidebar: { remotes: [{ name: 'origin', branches: [{ name: 'main', fullName: 'refs/remotes/origin/main', target: MAIN }] }] } } as never } });
  view.files = [{ path: 'README.md', oldPath: null }, { path: 'b.txt', oldPath: null }];
  view.compareCommits.mockReturnValue(true);
  useToast.getState().dismiss();
});

describe("a diff-line note's file:line (spec #4 §2: clicking opens that file's diff)", () => {
  it("opens the file in the compare of the merge base and the MR's head", async () => {
    api.mergeBase.mockResolvedValue(B);
    await openNoteFile('t', 'gitlab', mr, at('README.md'));
    expect(api.mergeBase).toHaveBeenCalledWith(4, MAIN, mr.headSha);
    expect(view.compareCommits).toHaveBeenCalledWith(B, mr.headSha);
    expect(view.openFile.mock.calls[0][0]).toMatchObject({ path: 'README.md', view: 'diff' });
  });

  it("lands on the note's line: its new line on the modified side, else its old line on the original side", async () => {
    api.mergeBase.mockResolvedValue(B);
    await openNoteFile('t', 'gitlab', mr, at('README.md', 92, 90));
    expect(view.openFile.mock.calls[0][0]).toMatchObject({ path: 'README.md', line: { side: 'modified', line: 92 } });
    await openNoteFile('t', 'gitlab', mr, at('README.md', null, 90));
    expect(view.openFile.mock.calls[1][0]).toMatchObject({ line: { side: 'original', line: 90 } });
    await openNoteFile('t', 'gitlab', mr, at('README.md', null, null));
    expect(view.openFile.mock.calls[2][0].line).toBeUndefined();
    // The next file (prefetched) has no line of its own.
    expect(view.openFile.mock.calls[0][1][0].line).toBeUndefined();
  });

  it("a range lands on its lines in the note's side: the cursor on the first, through the last", async () => {
    api.mergeBase.mockResolvedValue(B);
    await openNoteFile('t', 'gitlab', mr, at('README.md', 105, null, 100));
    expect(view.openFile.mock.calls[0][0]).toMatchObject({ line: { side: 'modified', line: 100, end: 105 } });
    await openNoteFile('t', 'gitlab', mr, at('README.md', null, 90, null, 88));
    expect(view.openFile.mock.calls[1][0]).toMatchObject({ line: { side: 'original', line: 88, end: 90 } });
  });

  it("names a note's place path:line, or path:start-end for a range, by the new side's numbers where they exist", () => {
    expect(noteWhere(at('a.php', 105))).toBe('a.php:105');
    expect(noteWhere(at('a.php', null, 90))).toBe('a.php:90');
    expect(noteWhere(at('a.php', null, null))).toBe('a.php');
    expect(noteWhere(at('a.php', 105, 101, 100, 96))).toBe('a.php:100-105');
    expect(noteWhere(at('a.php', null, 90, null, 88))).toBe('a.php:88-90');
    // From a context line (both numbers) to a removed one: the old side's.
    expect(noteWhere(at('a.php', null, 90, 85, 86))).toBe('a.php:86-90');
    // From a removed line (no new number) to an added one: only the end has a new number, so
    // it's that line, alone; it opens there.
    expect(noteWhere(at('a.php', 105, null, null, 98))).toBe('a.php:105');
    expect(noteLine(at('a.php', 105, null, null, 98))).toEqual({ side: 'modified', line: 105 });
    // A range that starts where it ends is one line.
    expect(noteLine(at('a.php', 105, null, 105))).toEqual({ side: 'modified', line: 105 });
  });

  it("says so when the MR's commits aren't loaded", async () => {
    api.mergeBase.mockResolvedValue(null);
    await openNoteFile('t', 'gitlab', mr, at('README.md'));
    expect(useToast.getState().message).toBe("The merge request's commits aren't in the loaded history: fetch, or check it out first");
    api.mergeBase.mockResolvedValue(B);
    view.compareCommits.mockReturnValue(false);
    await openNoteFile('t', 'github', mr, at('README.md'));
    expect(useToast.getState().message).toBe("The pull request's commits aren't in the loaded history: fetch, or check it out first");
    expect(view.openFile).not.toHaveBeenCalled();
  });

  it("says so when the file isn't in the diff any more", async () => {
    api.mergeBase.mockResolvedValue(B);
    await openNoteFile('t', 'gitlab', mr, at('gone.txt'));
    expect(useToast.getState().message).toBe("gone.txt isn't changed in this merge request any more");
  });
});
