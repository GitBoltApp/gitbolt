import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const { patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toast');
const { mrOf } = await import('../testMrs');

const B = 'b'.repeat(40);
const MAIN = 'm'.repeat(40);
const mr = mrOf(12);

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
    await openNoteFile('t', 'gitlab', mr, 'README.md');
    expect(api.mergeBase).toHaveBeenCalledWith(4, MAIN, mr.headSha);
    expect(view.compareCommits).toHaveBeenCalledWith(B, mr.headSha);
    expect(view.openFile.mock.calls[0][0]).toMatchObject({ path: 'README.md', view: 'diff' });
  });

  it("says so when the MR's commits aren't loaded", async () => {
    api.mergeBase.mockResolvedValue(null);
    await openNoteFile('t', 'gitlab', mr, 'README.md');
    expect(useToast.getState().message).toBe("The merge request's commits aren't in the loaded history: fetch, or check it out first");
    api.mergeBase.mockResolvedValue(B);
    view.compareCommits.mockReturnValue(false);
    await openNoteFile('t', 'github', mr, 'README.md');
    expect(useToast.getState().message).toBe("The pull request's commits aren't in the loaded history: fetch, or check it out first");
    expect(view.openFile).not.toHaveBeenCalled();
  });

  it("says so when the file isn't in the diff any more", async () => {
    api.mergeBase.mockResolvedValue(B);
    await openNoteFile('t', 'gitlab', mr, 'gone.txt');
    expect(useToast.getState().message).toBe("gone.txt isn't changed in this merge request any more");
  });
});
