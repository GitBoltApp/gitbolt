import { describe, expect, it, vi } from 'vitest';

const selectCommit = vi.fn(() => false);
vi.mock('../app/graphNav', () => ({ selectCommit }));
const listTreeFiles = vi.fn(async () => ['src/story.txt']);
vi.mock('../app/seams1b', () => ({ listTreeFiles, openFileView: vi.fn() }));
const openFileHistory = vi.fn(() => true);
vi.mock('../history/open', () => ({ openFileHistory }));
const show = vi.fn();

const { useRuntime } = await import('../app/runtime');
const { useToast } = await import('../ui/toast');
const { refEntries, fileEntries } = await import('./sources');

describe('refEntries', () => {
  it('toasts when the ref is outside the loaded history', () => {
    useRuntime.setState({ tabs: { t1: { sidebar: { locals: [{ name: 'main', fullName: 'refs/heads/main', target: 'abc' }], remotes: [], tags: [] } } as never } });
    useToast.setState({ show });
    const [entry] = refEntries('t1');
    entry.run();
    expect(selectCommit).toHaveBeenCalledWith('t1', 'abc', { focus: true });
    expect(show).toHaveBeenCalledWith('Not in the loaded history');
  });
});

describe('fileEntries', () => {
  it('Shift+Enter opens the file\'s history at HEAD (spec #3 §4.2: the palette)', async () => {
    const head = 'h'.repeat(40);
    useRuntime.setState({ tabs: { t2: { repo: { id: 7 }, graph: { head: { target: head } } } as never } });
    const [entry] = await fileEntries('t2');
    expect(entry.detail).toBe('Shift+Enter: file history');
    entry.alt!();
    expect(openFileHistory).toHaveBeenCalledWith('t2', { path: 'src/story.txt', rev: head }, false);
  });
});
