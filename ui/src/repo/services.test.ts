import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { CONTENT_CACHE_BYTES, CONTENT_CACHE_ENTRIES, contentKey, contentSize, createServices, filesKey } from './services';

const api = vi.hoisted(() => ({
  commitDetails: vi.fn(),
  commitMessage: vi.fn(),
  fileList: vi.fn(),
  diffContents: vi.fn(),
  signature: vi.fn(),
  treeFiles: vi.fn(),
  remotes: vi.fn(),
}));
vi.mock('../api/client', () => ({ api }));

const A = 'a'.repeat(40);
const flush = () => new Promise((r) => setTimeout(r, 0));
const blob = (b: Partial<BlobPayload>): BlobPayload => ({ size: 0, binary: false, encoding: 'UTF-8', eol: 'lf', text: null, base64: null, ...b });
const contents = (text: string): DiffContentsPayload => ({ old: null, new: blob({ text }), tooLarge: false, eolOnly: false, image: false });

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.fileList.mockResolvedValue({ files: [], added: 0, deleted: 0 });
  api.diffContents.mockImplementation(async (_repo: number, r: { path: string }) => contents(r.path));
  api.commitMessage.mockImplementation(async (_repo: number, id: string) => ({ id, summary: 's', body: '' }));
  api.remotes.mockResolvedValue([]);
});

describe('repo services', () => {
  it('caches commit file lists but never WIP or worktree ones (deviation 9)', async () => {
    const s = createServices(7);
    const commit = filesKey({ kind: 'commit', id: A, parent: 0 });
    const wip = filesKey({ kind: 'wip', worktree: '/r', staged: false });
    const worktree = filesKey({ kind: 'worktree', from: A, worktree: '/r' });
    for (const k of [commit, wip, worktree]) {
      await s.files.get(k);
      await flush();
      await s.files.get(k);
    }
    expect(api.fileList.mock.calls).toEqual([
      [7, { kind: 'commit', id: A, parent: 0 }],
      [7, { kind: 'wip', worktree: '/r', staged: false }],
      [7, { kind: 'wip', worktree: '/r', staged: false }],
      [7, { kind: 'worktree', from: A, worktree: '/r' }],
      [7, { kind: 'worktree', from: A, worktree: '/r' }],
    ]);
  });

  it('caches object contents but never worktree-side contents', async () => {
    const s = createServices(7);
    const obj = contentKey({ path: 'a.txt', old: { kind: 'absent' }, new: { kind: 'object', oid: A }, force: false });
    const live = contentKey({ path: 'b.txt', old: { kind: 'object', oid: A }, new: { kind: 'worktree', worktree: '/r' }, force: false });
    for (const k of [obj, live]) {
      await s.contents.get(k);
      await flush();
      await s.contents.get(k);
    }
    expect(api.diffContents.mock.calls.map(([repo, r]) => [repo, r.path])).toEqual([[7, 'a.txt'], [7, 'b.txt'], [7, 'b.txt']]);
    expect(s.contents.cache.maxEntries).toBe(CONTENT_CACHE_ENTRIES);
    expect(s.contents.cache.maxBytes).toBe(CONTENT_CACHE_BYTES);
    expect([CONTENT_CACHE_ENTRIES, CONTENT_CACHE_BYTES]).toEqual([64, 64 * 1024 * 1024]);
  });

  it('sizes contents by their decoded text (UTF-16) and base64 bytes', () => {
    expect(contentSize({ old: blob({ text: 'abc' }), new: blob({ base64: 'QUJD' }), tooLarge: false, eolOnly: false, image: true })).toBe(3 * 2 + 4);
    expect(contentSize({ old: null, new: null, tooLarge: true, eolOnly: false, image: false })).toBe(0);
  });

  it('builds the shared message cache on commitMessage (ruling F1)', async () => {
    const s = createServices(7);
    const [m1, m2] = await Promise.all([s.messages.get(A), s.messages.get(A)]);
    expect(m1).toEqual({ id: A, summary: 's', body: '' });
    expect(m2).toBe(m1);
    expect(s.messages.peek(A)).toBe(m1);
    expect(api.commitMessage.mock.calls).toEqual([[7, A]]);
  });

  it('loads the remotes once per repo', async () => {
    const s = createServices(7);
    await s.remotes();
    await s.remotes();
    expect(api.remotes.mock.calls).toEqual([[7]]);
  });

  it('retries the remotes after a failed load', async () => {
    api.remotes.mockRejectedValueOnce(new Error('offline'));
    const s = createServices(7);
    await expect(s.remotes()).rejects.toThrow('offline');
    expect(await s.remotes()).toEqual([]);
    expect(api.remotes).toHaveBeenCalledTimes(2);
  });
});
