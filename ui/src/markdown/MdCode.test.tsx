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

const { MdCode, MdSuggestion } = await import('./MdCode');
const { linesBase, MdSuggestionBase } = await import('./suggestion');
const { useTheme } = await import('../theme/store');
const { useToast } = await import('../ui/toastStore');

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

  it("marks a changed line's changed words over its tint, keeping Shiki's colours", async () => {
    shiki.highlightCode.mockResolvedValue({ lines: [
      [{ content: 'const', color: '#569cd6' }, { content: ' port = 8080;', color: '#d4d4d4' }],
      [{ content: 'const', color: '#569cd6' }, { content: ' port = 9090;', color: '#d4d4d4' }],
    ] });
    const { container } = render(<MdCode code={'const port = 8080;\nconst port = 9090;'} lang="ts" marks="-+" words="13-17;13-17" />);
    // Plain at first (marked already), then in Shiki's colours.
    expect(container.querySelector('.md-code-word-del')).toHaveTextContent('8080');
    await waitFor(() => expect(container.querySelector('.md-code-del .md-code-word-del')).toHaveStyle({ color: '#d4d4d4' }));
    expect(container.querySelector('.md-code-del .md-code-word-del')).toHaveTextContent('8080');
    expect(container.querySelector('.md-code-add .md-code-word-add')).toHaveTextContent('9090');
    expect(container.querySelector('.md-code-del')).toHaveTextContent('const port = 8080;');
  });

  it('marks changed words in plain code too, and ignores ranges past the line', () => {
    shiki.highlightCode.mockResolvedValue(null);
    const { container } = render(<MdCode code={'a = 1\na = 2\nkept'} lang={null} marks="-+ " words="4-5;4-5,9-99;" />);
    expect([...container.querySelectorAll('.md-code-word-del, .md-code-word-add')].map((e) => e.textContent)).toEqual(['1', '2']);
    expect(container.querySelector('code')).toHaveTextContent('a = 1a = 2kept');
  });

  it("highlights a suggestion's diff in the commented file's language, keeping its tints and word marks, with a -/+ column", async () => {
    shiki.highlightCode.mockImplementation(async (code: string) => ({ lines: code.split('\n').map((l) => [{ content: l, color: '#9cdcfe' }]) }));
    const base = linesBase('gitlab', 'src/cart.ts', 1, 1, () => ['  return sum;']);
    const { container } = render(<MdSuggestionBase value={base}><MdSuggestion code="  return sum - discount;" lang="suggestion:-0+0" /></MdSuggestionBase>);
    await waitFor(() => expect(shiki.highlightCode).toHaveBeenCalledWith('  return sum;\n  return sum - discount;', 'typescript'));
    await waitFor(() => expect(container.querySelector('.md-code-add .md-code-word-add')).toHaveStyle({ color: '#9cdcfe' }));
    expect(container.querySelector('.md-code-add .md-code-word-add')).toHaveTextContent('- discount');
    expect(container.querySelector('pre')).toHaveClass('md-code-signs');
    expect([...container.querySelectorAll('.md-code-line')].map((l) => l.className)).toEqual(['md-code-line md-code-del', 'md-code-line md-code-add']);
  });

  it('keeps a suggestion plain for a file in no known language; other code has no -/+ column', async () => {
    shiki.highlightCode.mockResolvedValue(null);
    const base = linesBase('github', 'notes/LICENSE', 1, 1, () => ['a']);
    const { container } = render(<><MdSuggestionBase value={base}><MdSuggestion code="b" lang="suggestion" /></MdSuggestionBase><MdCode code="x" lang={null} marks="+" /></>);
    await act(async () => { await import('../diff/language'); });
    expect(shiki.highlightCode).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('pre')].map((p) => p.classList.contains('md-code-signs'))).toEqual([true, false]);
  });

  it('copies the code with the Copy button', async () => {
    shiki.highlightCode.mockResolvedValue(null);
    render(<MdCode code="npm test" lang="sh" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(copy.copyText).toHaveBeenCalledWith('npm test');
    await waitFor(() => expect(useToast.getState().message).toBe('Copied'));
  });

  it('marks a changed block’s lines (5C), and copies only the new ones', async () => {
    shiki.highlightCode.mockResolvedValue(null);
    const { container } = render(<MdCode code={'a = 1\na = 2\nend'} lang="py" marks="-+ " />);
    const lines = [...container.querySelectorAll('.md-code-line')].map((l) => [l.textContent, l.className]);
    expect(lines).toEqual([['a = 1', 'md-code-line md-code-del'], ['a = 2', 'md-code-line md-code-add'], ['end', 'md-code-line']]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(copy.copyText).toHaveBeenCalledWith('a = 2\nend'));
  });
});
