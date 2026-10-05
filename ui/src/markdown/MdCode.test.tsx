import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no IntersectionObserver: every block counts as near the viewport. The queue is
// tested on its own; here `highlightCode` stands for "the tokens the queue answers".
const shiki = vi.hoisted(() => ({ highlightCode: vi.fn() }));
vi.mock('./highlightQueue', () => ({
  queueHighlight: (code: string, lang: string) => ({ result: Promise.resolve(shiki.highlightCode(code, lang)), cancel: () => {} }),
}));
const copy = vi.hoisted(() => ({ copyText: vi.fn(async () => {}) }));
vi.mock('../api/transport', async (orig) => ({ ...(await orig<typeof import('../api/transport')>()), ...copy }));

const { MdCode } = await import('./MdCode');
const { useTheme } = await import('../theme/store');
const { useToast } = await import('../ui/toast');

beforeEach(() => { vi.clearAllMocks(); useToast.getState().dismiss(); });

describe('MdCode (spec #5 §3.1)', () => {
  it('highlights with Shiki in the fence’s language, keeping the text while it loads', async () => {
    shiki.highlightCode.mockResolvedValue({ lines: [[{ content: 'const', color: '#569cd6' }, { content: ' a = 1;' }]] });
    const { container } = render(<MdCode code="const a = 1;" lang="ts" />);
    expect(container.querySelector('code')).toHaveTextContent('const a = 1;');
    await waitFor(() => expect(container.querySelectorAll('code span')).toHaveLength(2));
    expect(container.querySelector('code span')).toHaveStyle({ color: '#569cd6' });
    expect(shiki.highlightCode).toHaveBeenCalledWith('const a = 1;', 'ts');
  });

  it('keeps no language, or a block over 16 384 characters, plain without queueing it', () => {
    shiki.highlightCode.mockResolvedValue(null);
    render(<><MdCode code="x" lang={null} /><MdCode code={'y'.repeat(20_000)} lang="ts" /></>);
    expect(shiki.highlightCode).not.toHaveBeenCalled();
  });

  it('re-highlights when the theme changes, keeping the old colours until the new ones arrive', async () => {
    shiki.highlightCode.mockResolvedValueOnce({ lines: [[{ content: 'a', color: '#111111' }]] });
    const { container } = render(<MdCode code="a" lang="ts" />);
    await waitFor(() => expect(container.querySelector('code span')).toHaveStyle({ color: '#111111' }));
    let resolve: (v: unknown) => void = () => {};
    shiki.highlightCode.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    act(() => { useTheme.setState({ id: useTheme.getState().id === 'light' ? 'monokai' : 'light' }); });
    expect(container.querySelector('code span')).toHaveStyle({ color: '#111111' });
    await act(async () => { resolve({ lines: [[{ content: 'a', color: '#222222' }]] }); });
    expect(container.querySelector('code span')).toHaveStyle({ color: '#222222' });
    expect(shiki.highlightCode).toHaveBeenCalledTimes(2);
  });

  it('copies the code with the Copy button', async () => {
    shiki.highlightCode.mockResolvedValue(null);
    render(<MdCode code="npm test" lang="sh" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(copy.copyText).toHaveBeenCalledWith('npm test');
    await waitFor(() => expect(useToast.getState().message).toBe('Copied'));
  });
});
