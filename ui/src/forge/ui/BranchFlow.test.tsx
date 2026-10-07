import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RowPayload } from '../../api/gen/RowPayload';
import { BranchFlow, FlowStrip } from './BranchFlow';
import { commitsBetween, type RangeState } from './rangeStats';

const LONG = 'feature/a-very-long-branch-name-that-cannot-fit-in-half-of-the-card';
const ready = (commits: Array<{ sha: string; summary: string }> | null): RangeState => ({ status: 'ready', stats: { commits, files: 5, added: 128, deleted: 41 } });
const flow = (stats: RangeState, extra: { count?: number | null; none?: string } = {}) => (
  <BranchFlow from={{ branch: LONG, sub: 'origin' }} into={{ branch: 'dev', sub: 'origin' }} stats={stats} {...extra} />
);

describe('BranchFlow', () => {
  it('a long branch name ends in an ellipsis and its tooltip says it whole', async () => {
    render(flow({ status: 'loading' }));
    const name = screen.getByText(LONG);
    expect(name).toHaveClass('flow-name');
    fireEvent.mouseEnter(name.closest('.flow-branch')!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(LONG);
  });

  it('counts commits, files and lines; the commit list expands and collapses', () => {
    render(flow(ready([{ sha: 'a1f3c9e00', summary: 'Build the request' }, { sha: '7be2d1000', summary: 'Resolve the currency' }])));
    const card = screen.getByRole('region', { name: 'Branches' });
    expect(card).toHaveTextContent('2 commits5 files+128−41');
    const more = within(card).getByRole('button', { name: /Show commits/ });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(within(card).getByRole('list', { name: 'Commits' })).toHaveTextContent('a1f3c9eBuild the request7be2d10Resolve the currency');
    fireEvent.click(within(card).getByRole('button', { name: /Hide commits/ }));
    expect(within(card).queryByRole('list', { name: 'Commits' })).toBeNull();
  });

  it('the whole bar is the toggle: one button, a click on its counts toggles too', () => {
    render(flow(ready([{ sha: 'a1f3c9e00', summary: 'Build the request' }])));
    const card = screen.getByRole('region', { name: 'Branches' });
    const bar = within(card).getByRole('button', { name: /Show commits/ });
    expect(bar).toHaveClass('flow-meta');
    expect(bar).toHaveTextContent('1 commit5 files+128−41Show commits');
    fireEvent.click(bar.querySelector('.flow-add')!);
    expect(bar).toHaveAttribute('aria-expanded', 'true');
    expect(within(card).getByRole('list', { name: 'Commits' })).toBeTruthy();
    expect(within(bar).queryAllByRole('button')).toEqual([]);
  });

  // --- MR round 2: Compare ---
  it("Compare sits at the bar's right end, past a divider, and its click doesn't toggle the list", () => {
    const run = vi.fn();
    const { rerender } = render(<BranchFlow from={{ branch: 'dev', sub: 'o' }} into={{ branch: 'main', sub: 'o' }} stats={ready([{ sha: 'a1f3c9e00', summary: 'One' }])} compare={{ run, busy: false }} />);
    const card = screen.getByRole('region', { name: 'Branches' });
    const compare = within(card).getByRole('button', { name: 'Compare' });
    expect(compare.previousElementSibling).toHaveClass('flow-divider');
    expect(compare.closest('.flow-toggle')).toBeNull();
    fireEvent.mouseEnter(compare);
    expect(screen.getByRole('tooltip')).toHaveTextContent("Compare the MR's changes in the diff view");
    fireEvent.click(compare);
    expect(run).toHaveBeenCalledTimes(1);
    expect(within(card).getByRole('button', { name: /Show commits/ })).toHaveAttribute('aria-expanded', 'false');
    // Fetching the head: a spinner in the icon, and no second click.
    rerender(<BranchFlow from={{ branch: 'dev', sub: 'o' }} into={{ branch: 'main', sub: 'o' }} stats={{ status: 'none' }} none="Its commits aren't fetched into this repository" compare={{ run, busy: true }} />);
    const busy = within(card).getByRole('button', { name: 'Compare' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy.querySelector('.spin')).toBeTruthy();
    fireEvent.click(busy);
    expect(run).toHaveBeenCalledTimes(1);
  });
  // --- end MR round 2 ---

  it('says Counting… while it loads, a fallback count or the note when the repository lacks the commits', () => {
    const { rerender } = render(flow({ status: 'loading' }));
    expect(screen.getByText('Counting…')).toBeTruthy();
    rerender(flow({ status: 'none' }, { none: 'Merged into dev' }));
    expect(screen.getByText('Merged into dev')).toBeTruthy();
    rerender(flow({ status: 'none' }, { count: 3 }));
    expect(screen.getByRole('region', { name: 'Branches' })).toHaveTextContent('3 commits');
    // The graph didn't reach: no list, the fallback count.
    rerender(flow(ready(null), { count: 1 }));
    expect(screen.getByRole('region', { name: 'Branches' })).toHaveTextContent('1 commit5 files');
    expect(screen.queryByRole('button', { name: /Show commits/ })).toBeNull();
  });

  it('a target branch picker is a named button; the strip shows its message and action', () => {
    const onPick = vi.fn();
    render(<BranchFlow from={{ branch: 'f', sub: 'origin' }} into={{ branch: 'dev', sub: 'origin', pick: { label: 'Target branch', onPick } }} stats={{ status: 'loading' }} strip={<FlowStrip action={<button type="button">Push</button>}>not pushed</FlowStrip>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target branch' }));
    expect(onPick).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('not pushed');
  });
});

describe('commitsBetween (the first-parent line from the tip down to the base)', () => {
  const row = (id: string, parents: string[]) => ({ id, parents, summary: `s-${id}`, wip: null }) as unknown as RowPayload;
  const rows = [row('t', ['m', 'x']), row('x', ['b']), row('m', ['b']), row('b', ['r']), row('r', [])];
  it('oldest first, the base left out; the tip itself is empty', () => {
    expect(commitsBetween(rows, 't', 'b')?.map((c) => c.sha)).toEqual(['m', 't']);
    expect(commitsBetween(rows, 'b', 'b')).toEqual([]);
  });
  it("null when the walk leaves the loaded graph or never meets the base", () => {
    expect(commitsBetween(rows, 'gone', 'b')).toBeNull();
    expect(commitsBetween(rows, 't', 'x')).toBeNull();
  });
});

describe("BranchFlow's commit rows jump to the graph", () => {
  const commits = [{ sha: 'a1f3c9e00', summary: 'Build the request' }, { sha: '7be2d1000', summary: 'Resolve the currency' }];
  const show = (open: (sha: string) => void) => {
    render(<BranchFlow from={{ branch: 'dev', sub: 'origin' }} into={{ branch: 'main', sub: 'origin' }} stats={ready(commits)} jump={{ inGraph: (sha) => sha === 'a1f3c9e00', open }} />);
    fireEvent.click(screen.getByRole('button', { name: /Show commits/ }));
    return within(screen.getByRole('list', { name: 'Commits' }));
  };

  it('a loaded commit is a real button (focusable; Enter clicks it): a click opens it', () => {
    const open = vi.fn();
    const list = show(open);
    const row = list.getByRole('button', { name: /a1f3c9e/ });
    expect(row.tagName).toBe('BUTTON');
    expect(row).toHaveClass('flow-commit');
    row.focus();
    expect(row).toHaveFocus();
    fireEvent.click(row);
    expect(open).toHaveBeenCalledWith('a1f3c9e00');
  });

  it("one the graph hasn't loaded isn't clickable: dim, with why in its tooltip", async () => {
    const open = vi.fn();
    const list = show(open);
    expect(list.queryByRole('button', { name: /7be2d10/ })).toBeNull();
    const row = list.getByText('Resolve the currency').closest('.flow-commit')!;
    expect(row).toHaveClass('missing');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(row);
    expect(open).not.toHaveBeenCalled();
    fireEvent.mouseEnter(row);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Not in the graph yet: fetch first');
  });
});
