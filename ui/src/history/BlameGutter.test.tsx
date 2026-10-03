import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlamePayload } from '../api/gen/BlamePayload';
import type { FileMargin } from '../diff/monaco/fileMargin';

const blameApi = vi.hoisted(() => vi.fn());
const monaco = vi.hoisted(() => ({ host: null as unknown }));
vi.mock('../api/client', () => ({ api: { avatar: vi.fn(async () => null), blame: blameApi }, errorMessage: String }));
vi.mock('../diff/TextDiff', () => ({ useMonacoHost: () => ({ host: monaco.host, error: null, retry: () => {} }) }));
const { BlameGutter, BlameLayer, BLAME_MARGIN_PX, BLAME_MARGIN_SHARE } = await import('./BlameGutter');
const { row } = await import('./testRows');

const a = 'a'.repeat(40), b = 'b'.repeat(40);
const blame: BlamePayload = {
  hunks: [{ sha: a, start: 1, lines: 2 }, { sha: b, start: 3, lines: 2 }, { sha: a, start: 5, lines: 4 }],
  commits: [
    { sha: a, author: 'Ada Lovelace', email: 'ada@example.com', time: 1_767_225_600, summary: 'Start the story', boundary: true },
    { sha: b, author: 'Grace Hopper', email: 'grace@example.com', time: 1_767_225_700, summary: 'Add the middle', boundary: false },
  ],
};

function fakeHost() {
  const node = document.createElement('div');
  document.body.appendChild(node);
  const margin: FileMargin = { node, lineTop: (n) => (n - 1) * 19, lineBottom: (n) => n * 19, visibleLines: () => ({ first: 1, last: 8 }), metrics: () => ({ lineHeight: 19, fontSize: 13 }), onChange: () => () => {} };
  return { node, setFileMargin: vi.fn((w: number) => (w > 0 ? margin : null)) };
}

describe('the blame gutter (spec #3 §3.10, §4.2)', () => {
  it('draws one row per line group in the strip, at its lines, with its commit', () => {
    const host = fakeHost();
    render(<BlameGutter host={host as never} blame={blame} onPick={vi.fn()} />);
    expect(host.setFileMargin).toHaveBeenCalledWith(BLAME_MARGIN_PX, BLAME_MARGIN_SHARE);
    const groups = screen.getAllByTestId('blame-group');
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => host.node.contains(g))).toBe(true);
    expect(groups.map((g) => [g.style.top, g.style.height])).toEqual([['0px', '38px'], ['38px', '38px'], ['76px', '76px']]);
    expect(groups[1]).toHaveTextContent('Add the middle');
    expect(groups.map((g) => g.dataset.line)).toEqual(['1', '3', '5']);
  });

  it('rows take Monaco\'s line box and font size (UX B.3: one baseline with the code)', () => {
    const host = fakeHost();
    render(<BlameGutter host={host as never} blame={blame} onPick={vi.fn()} />);
    const gutter = screen.getByTestId('blame-gutter');
    expect(gutter.style.getPropertyValue('--blame-line')).toBe('19px');
    expect(gutter.style.getPropertyValue('--blame-font')).toBe('13px');
    expect(screen.getAllByTestId('avatar')[0].style.width).toBe('16px');
  });

  it('hovering a group shows its whole summary, author and date', async () => {
    const host = fakeHost();
    render(<BlameGutter host={host as never} blame={blame} onPick={vi.fn()} />);
    fireEvent.mouseEnter(screen.getAllByTestId('blame-group')[1], { clientX: 10, clientY: 40 });
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Add the middle');
    expect(tip).toHaveTextContent(/Grace Hopper · .+ ago · \d{4}-\d{2}-\d{2} @/);
  });

  it('a click picks the commit; Alt+click picks it in the graph', () => {
    const host = fakeHost();
    const onPick = vi.fn();
    render(<BlameGutter host={host as never} blame={blame} onPick={onPick} />);
    fireEvent.click(screen.getAllByTestId('blame-group')[1]);
    expect(onPick).toHaveBeenLastCalledWith(b, false);
    fireEvent.click(screen.getAllByTestId('blame-group')[0], { altKey: true });
    expect(onPick).toHaveBeenLastCalledWith(a, true);
  });

  /** Review Focus 3. */
  it('unmounting the gutter gives the editor its margin back', () => {
    const host = fakeHost();
    const { unmount } = render(<BlameGutter host={host as never} blame={blame} onPick={vi.fn()} />);
    unmount();
    expect(host.setFileMargin).toHaveBeenLastCalledWith(0);
  });

  /** Fix round 1: no layout shift while the next commit's blame loads. */
  it('switching to an uncached commit keeps the strip (empty, never the old rows); only turning Blame off gives it back', async () => {
    const host = fakeHost();
    monaco.host = host;
    let resolveB!: (p: BlamePayload) => void;
    blameApi.mockReset().mockResolvedValueOnce(blame).mockReturnValueOnce(new Promise<BlamePayload>((r) => { resolveB = r; }));
    const onPick = vi.fn();
    const { rerender, unmount } = render(<BlameLayer repoId={901} worktree="/r" row={row('c1')} onPick={onPick} />);
    expect(await screen.findAllByTestId('blame-group')).toHaveLength(3);
    rerender(<BlameLayer repoId={901} worktree="/r" row={row('c2')} onPick={onPick} />);
    expect(screen.queryAllByTestId('blame-group')).toHaveLength(0);
    expect(screen.getByTestId('blame-gutter')).toHaveAttribute('aria-busy', 'true');
    expect(blameApi).toHaveBeenLastCalledWith(901, '/r', 'c2', 'src/story.txt');
    await act(async () => resolveB({ ...blame, hunks: [{ sha: b, start: 1, lines: 8 }] }));
    expect(screen.getAllByTestId('blame-group')).toHaveLength(1);
    expect(host.setFileMargin.mock.calls.map(([w]) => w)).toEqual([BLAME_MARGIN_PX]);
    unmount();
    expect(host.setFileMargin).toHaveBeenLastCalledWith(0);
  });

  it('a failed blame says why and keeps the strip reserved', async () => {
    const host = fakeHost();
    monaco.host = host;
    blameApi.mockReset().mockRejectedValueOnce('boom');
    render(<BlameLayer repoId={902} worktree="/r" row={row('c1')} onPick={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the blame: boom");
    expect(host.setFileMargin.mock.calls.map(([w]) => w)).toEqual([BLAME_MARGIN_PX]);
  });
});
