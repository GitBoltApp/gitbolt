import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { RowPayload } from '../api/gen/RowPayload';

const actions = vi.hoisted(() => ({ registerFileLinkHandler: vi.fn((_fn: unknown) => () => {}) }));
const images = vi.hoisted(() => ({ registerRepoImageLoader: vi.fn((_fn: unknown) => () => {}) }));
vi.mock('./actions', () => actions);
vi.mock('./MdImage', () => images);

const { loadRepoImage, openFileLink, releaseRepoImage } = await import('./fileLinks');
// Registered at import, before any beforeEach clears the mocks.
const registeredLinks = actions.registerFileLinkHandler.mock.calls.map((c) => c[0]);
const registeredImages = images.registerRepoImageLoader.mock.calls.map((c) => c[0]);
const { historyOf, placeKey, useNavHistory } = await import('../nav/history');
const { takePendingScroll } = await import('../nav/scroll');
const { useTabViews } = await import('../app/tabStores');
const { EMPTY_GRAPH } = await import('../app/testShell');
const { Loader } = await import('../data/loader');
const { Lru } = await import('../data/lru');
const { createRepoViewStore, fileViewTarget } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');
const { useToast } = await import('../ui/toast');

const A = 'a'.repeat(40);
const specA = { kind: 'commit', id: A, parent: 0 } as const;
const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: 'Docs', bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null }) as RowPayload;
const change = (path: string): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object', oid: '1'.repeat(40) }, new: { kind: 'object', oid: '2'.repeat(40) }, submodule: false });
const side = (p: Partial<NonNullable<DiffContentsPayload['new']>>) => ({ size: 10, binary: false, encoding: 'UTF-8', eol: 'lf' as const, text: null, base64: null, hash: null, ...p });
const payload = (path: string): DiffContentsPayload => {
  const base = { old: null, tooLarge: false, eolOnly: false, image: false };
  if (path.endsWith('logo.png')) return { ...base, image: true, new: side({ binary: true, encoding: '', base64: 'iVBORw0KGgo=' }) };
  if (path.endsWith('diagram.svg')) return { ...base, new: side({ text: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) };
  if (path.endsWith('big.png')) return { ...base, image: true, tooLarge: true, new: side({ binary: true, encoding: '' }) };
  return { ...base, new: side({ text: `# ${path}\n` }) };
};
const present = new Set(['README.md', 'docs/guide.md', 'docs/img/logo.png', 'docs/img/diagram.svg', 'docs/img/big.png']);
const fetchContents = vi.fn(async (key: string) => {
  const r = JSON.parse(key) as { path: string; new: { kind: string } };
  if (r.new.kind === 'object' || present.has(r.path)) return payload(r.path);
  throw new Error('not found');
});
let created = 0;

let store: ReturnType<typeof createRepoViewStore>;
beforeEach(() => {
  vi.clearAllMocks();
  useNavHistory.setState({ byTab: {} });
  useToast.setState({ message: null });
  created = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++created}`);
  URL.revokeObjectURL = vi.fn();
  const files = new Loader(async () => ({ files: ['README.md', 'docs/guide.md'].map(change), added: 0, deleted: 0 }) as unknown as FileListPayload, new Lru<string, FileListPayload>(10));
  store = createRepoViewStore(1, '/r', { ...EMPTY_GRAPH, rows: [row(A)] }, fakeServices({ contents: new Loader(fetchContents, new Lru<string, DiffContentsPayload>(50)), files }));
  useTabViews.setState({ views: { t: { repo: 1, services: store.getState().services, store } } });
});

const ctx = (path = 'README.md') => ({ kind: 'file' as const, tabId: 't', commit: A, path });

describe('relative links (spec #5 §4.1)', () => {
  it('are registered with the renderer', () => {
    expect(registeredLinks).toEqual([openFileLink]);
    expect(registeredImages).toEqual([loadRepoImage]);
  });

  it('open that file in File View at the same commit, as a new place', async () => {
    store.getState().selectRow(0);
    store.getState().openFile(fileViewTarget('README.md', A, specA));
    openFileLink(ctx(), 'docs/guide.md', null);
    await vi.waitFor(() => expect(store.getState().diff).toMatchObject({ path: 'docs/guide.md', view: 'file' }));
    expect(historyOf('t').places.map(placeKey)).toEqual([`file:${A}:README.md`, `file:${A}:docs/guide.md`]);
  });

  it('a missing file toasts and changes nothing', async () => {
    store.getState().selectRow(0);
    store.getState().openFile(fileViewTarget('README.md', A, specA));
    openFileLink(ctx(), 'docs/nope.md', null);
    await vi.waitFor(() => expect(useToast.getState().message).toBe(`docs/nope.md isn't in ${A.slice(0, 6)}`));
    expect(store.getState().diff).toMatchObject({ path: 'README.md' });
    expect(historyOf('t').places).toHaveLength(1);
  });

  it("a link's #heading is where the opened file's rendered view scrolls", async () => {
    openFileLink(ctx(), 'docs/guide.md', 'install');
    await vi.waitFor(() => expect(store.getState().diff).toMatchObject({ path: 'docs/guide.md' }));
    expect(takePendingScroll('t', 'file', `file:${A}:docs/guide.md`, 'rendered')).toMatchObject({ anchor: 'install' });
  });

  it("a link to the same file's heading scrolls the shown rendered view", () => {
    const pane = document.createElement('div');
    pane.className = 'md-rendered';
    pane.getClientRects = () => ({ length: 1 }) as unknown as DOMRectList;
    pane.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const h = document.createElement('h2');
    h.id = 'user-content-usage';
    h.getBoundingClientRect = () => ({ top: 900 }) as DOMRect;
    pane.append(h);
    document.body.append(pane);
    openFileLink(ctx(), 'README.md', 'usage');
    expect(pane.scrollTop).toBe(800);
    pane.remove();
  });
});

describe('relative images (spec #5 §4.2)', () => {
  it('read a raster image at the commit once, as an object URL', async () => {
    expect(await loadRepoImage(ctx(), 'docs/img/logo.png', A)).toBe('blob:1');
    expect(await loadRepoImage(ctx(), 'docs/img/logo.png', A)).toBe('blob:1');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect((vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).type).toBe('image/png');
  });

  it('an SVG shows as an image (an image/svg+xml blob), never inlined', async () => {
    expect(await loadRepoImage(ctx(), 'docs/img/diagram.svg', A)).toMatch(/^blob:/);
    expect((vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).type).toBe('image/svg+xml');
  });

  it('not an image, missing, or too large: nothing (the renderer shows the alt text)', async () => {
    expect(await loadRepoImage(ctx(), 'README.md', A)).toBeNull();
    expect(await loadRepoImage(ctx(), 'docs/img/none.png', A)).toBeNull();
    expect(await loadRepoImage(ctx(), 'docs/img/big.png', A)).toBeNull();
  });

  it('the working tree is read each time (it changes)', async () => {
    const first = await loadRepoImage({ ...ctx(), commit: 'worktree' }, 'docs/img/logo.png', 'worktree');
    const second = await loadRepoImage({ ...ctx(), commit: 'worktree' }, 'docs/img/logo.png', 'worktree');
    expect(first).not.toBe(second);
  });

  it('never revokes a URL a mounted image shows; a hit counts as a use; a working-tree URL goes with its image', async () => {
    URL.createObjectURL = vi.fn(() => `blob:lru-${++created}`); // unlike the earlier tests' URLs
    const paths = Array.from({ length: 70 }, (_, i) => `docs/img/n${i}-logo.png`);
    paths.forEach((p) => present.add(p));
    const got: string[] = [];
    for (const p of paths) got.push((await loadRepoImage(ctx(), p, A))!);
    // 70 + the earlier tests' images, all still shown: none revoked.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    for (const u of got) releaseRepoImage(u);
    const revoked = vi.mocked(URL.revokeObjectURL).mock.calls.map((c) => c[0]);
    expect(revoked).toContain(got[0]);
    // Scrolling through more images, one used over and over (a hit each time) stays cached.
    const kept = (await loadRepoImage(ctx(), paths[69]!, A))!;
    for (let i = 70; i < 140; i++) {
      const p = `docs/img/n${i}-logo.png`;
      present.add(p);
      releaseRepoImage((await loadRepoImage(ctx(), p, A))!);
      releaseRepoImage((await loadRepoImage(ctx(), paths[69]!, A))!);
    }
    releaseRepoImage(kept);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(kept);
    expect(await loadRepoImage(ctx(), paths[69]!, A)).toBe(kept);
    // The working tree's: revoked once no image shows it.
    const wt = (await loadRepoImage({ ...ctx(), commit: 'worktree' }, 'docs/img/logo.png', 'worktree'))!;
    expect(revoked).not.toContain(wt);
    releaseRepoImage(wt);
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith(wt);
  });
});
