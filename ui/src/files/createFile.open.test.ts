import { beforeEach, describe, expect, it, vi } from 'vitest';

const createWorktreeFile = vi.hoisted(() => vi.fn(async () => ({ outcome: null, journal: null, staging: null, wip: null })));
vi.mock('../api/client', () => ({ api: { createWorktreeFile }, errorMessage: (e: unknown) => String(e) }));
const runWrite = vi.hoisted(() => vi.fn(async (_ctx: unknown, send: () => Promise<unknown>) => send()));
vi.mock('../write/client', () => ({ runWrite }));
const openFile = vi.hoisted(() => vi.fn());
vi.mock('../app/tabStores', () => ({ tabStore: () => ({ getState: () => ({ openFile, diff: null }) }), tabIdOf: () => 't1' }));
// The focus waits for the editor: never loaded here.
vi.mock('../diff/monaco/load', () => ({ loadMonacoHost: () => new Promise(() => {}) }));

const { createFile } = await import('./createFile');
const { useDiffPrefs } = await import('../diff/diffPrefs');
const { markdownViewOf, clearMarkdownOverride } = await import('../diff/markdownOverride');
const ctx = { tabId: 't1', repoId: 3, worktree: '/r' };

describe('createFile opens the new file to type into (UX round 3 O.1)', () => {
  beforeEach(() => { openFile.mockReset(); useDiffPrefs.getState().set({ markdownView: 'rendered' }); clearMarkdownOverride(); });

  it('a new Markdown file opens in Source, not an empty Rendered page over a hidden editor; only it', async () => {
    expect(await createFile(ctx, 'docs/new.md')).toBe(true);
    expect(markdownViewOf('docs/new.md')).toBe('source');
    // The app-wide pick stays: every other Markdown file still opens Rendered.
    expect(useDiffPrefs.getState().prefs.markdownView).toBe('rendered');
    expect(markdownViewOf('README.md')).toBe('rendered');
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'docs/new.md', view: 'file' }));
  });

  it('another file leaves the Markdown view as it was', async () => {
    expect(await createFile(ctx, 'src/new.txt')).toBe(true);
    expect(useDiffPrefs.getState().prefs.markdownView).toBe('rendered');
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/new.txt', view: 'file' }));
  });
});
