import { describe, expect, it, vi } from 'vitest';

const selectCommit = vi.fn(() => false);
vi.mock('../app/graphNav', () => ({ selectCommit }));
const show = vi.fn();

const { useRuntime } = await import('../app/runtime');
const { useToast } = await import('../ui/toast');
const { refEntries } = await import('./sources');

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
