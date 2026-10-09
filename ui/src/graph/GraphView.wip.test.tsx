import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { GraphView } from './GraphView';
import { flushDrafts, readWipDraft, reloadDrafts, writeWipDraft } from '../commit/draft';

HTMLCanvasElement.prototype.getContext = (() => null) as never;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });

const base = { lane: 0, color: 0, segments: [], bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [] };
type Counts = Partial<Record<'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted', number>>;
const wipRow = (path: string, name: string | null, counts: Counts) => ({
  ...base, id: `wip:${path}`, kind: 'wip' as const, summary: '// WIP',
  wip: { worktreePath: path, worktreeName: name, modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0, ...counts },
});
const commit = { ...base, id: 'a'.repeat(40), kind: 'commit' as const, summary: 'c0', wip: null };
const payload = (...rows: ReturnType<typeof wipRow>[]): GraphPayload => ({
  rows: [...rows, commit], labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [],
});
const input = (i = 0) => screen.getAllByPlaceholderText('// WIP')[i] as HTMLInputElement;

beforeEach(() => { flushDrafts(); localStorage.clear(); reloadDrafts(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('WIP row counts (K47)', () => {
  it('shows each non-zero type with its status icon, and nothing for zero types', () => {
    render(<GraphView graph={payload(wipRow('/r', null, { modified: 3, added: 2, renamed: 1 }))} repoId="/r" />);
    const counts = screen.getByTestId('wip-counts');
    expect(counts).toHaveAccessibleName('3 modified · 2 added · 1 renamed');
    expect([...counts.querySelectorAll('svg')].map((s) => s.getAttribute('data-status'))).toEqual(['modified', 'added', 'renamed']);
    expect(counts.textContent).toBe('321');
    expect(counts.querySelector('[data-status="modified"]')).toHaveStyle({ color: 'var(--status-modified)' });
  });

  it('shows deleted too, and no counts element when clean', () => {
    const { unmount } = render(<GraphView graph={payload(wipRow('/r', null, { deleted: 4 }))} repoId="/r" />);
    expect(screen.getByTestId('wip-counts').querySelector('[data-status="deleted"]')).not.toBeNull();
    unmount();
    render(<GraphView graph={payload(wipRow('/r', null, {}))} repoId="/r" />);
    expect(screen.queryByTestId('wip-counts')).toBeNull();
  });
});

describe('WIP row draft summary (K48)', () => {
  it('stores the typed draft (debounced) and reloads it per repo and worktree', () => {
    const g = payload(wipRow('/r', null, { modified: 1 }), wipRow('/r-wt', 'wt', { added: 1 }));
    const { unmount } = render(<GraphView graph={g} repoId="/r" />);
    fireEvent.change(input(0), { target: { value: 'fix the thing' } });
    expect(localStorage.getItem('gitbolt.wipDraft.v2')).toBeNull();
    act(() => { vi.advanceTimersByTime(400); });
    expect(readWipDraft('/r', '/r').summary).toBe('fix the thing');
    expect(readWipDraft('/r', '/r-wt').summary).toBe('');
    expect(readWipDraft('/other', '/r').summary).toBe('');
    unmount();
    render(<GraphView graph={g} repoId="/r" />);
    expect(input(0).value).toBe('fix the thing');
    expect(input(1).value).toBe('');
  });

  it('flushes a pending draft on blur and clears storage when emptied', () => {
    render(<GraphView graph={payload(wipRow('/r', null, { modified: 1 }))} repoId="/r" />);
    fireEvent.change(input(), { target: { value: 'abc' } });
    fireEvent.blur(input());
    expect(readWipDraft('/r', '/r').summary).toBe('abc');
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.blur(input());
    expect(JSON.parse(localStorage.getItem('gitbolt.wipDraft.v2') ?? '{}')).toEqual({});
  });

  it('has no length limit; the counter shows past 60 and warns past 72', () => {
    render(<GraphView graph={payload(wipRow('/r', null, { modified: 1 }))} repoId="/r" />);
    expect(input().maxLength).toBe(-1);
    fireEvent.change(input(), { target: { value: 'x'.repeat(60) } });
    expect(screen.queryByTestId('wip-counter')).toBeNull();
    fireEvent.change(input(), { target: { value: 'x'.repeat(61) } });
    expect(screen.getByTestId('wip-counter')).toHaveTextContent('61');
    expect(screen.getByTestId('wip-counter')).not.toHaveClass('warn');
    fireEvent.change(input(), { target: { value: 'x'.repeat(73) } });
    expect(screen.getByTestId('wip-counter')).toHaveClass('warn');
    expect(readWipDraft('/r', '/r').summary).toBe('x'.repeat(73));
  });

  it('edits the shared draft, keeping its description', () => {
    writeWipDraft('/r', '/r', { summary: 'from the commit box', description: 'kept' });
    render(<GraphView graph={payload(wipRow('/r', null, { modified: 1 }))} repoId="/r" />);
    expect(input().value).toBe('from the commit box');
    fireEvent.change(input(), { target: { value: 'new' } });
    expect(readWipDraft('/r', '/r')).toEqual({ summary: 'new', description: 'kept' });
  });

  it('a press in the input selects the WIP row (plain; Ctrl/Shift as a row click), and the click toggles nothing', () => {
    const onSelect = vi.fn();
    render(<GraphView graph={payload(wipRow('/r', null, { modified: 1 }))} repoId="/r" selected={1} onSelect={onSelect} />);
    fireEvent.mouseDown(input());
    expect(onSelect).toHaveBeenLastCalledWith(0, { ctrl: false, shift: false });
    fireEvent.click(input());
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(input(), { ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(0, { ctrl: true, shift: false });
    fireEvent.mouseDown(input(), { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(0, { ctrl: false, shift: true });
  });

  it('keys typed in the input never reach the graph or app shortcuts', () => {
    const onUnhandledKey = vi.fn(() => true);
    const appKey = vi.fn();
    document.addEventListener('keydown', appKey);
    render(<GraphView graph={payload(wipRow('/r', null, { modified: 1 }))} repoId="/r" selected={0} onSelect={() => {}} onUnhandledKey={onUnhandledKey} />);
    input().focus();
    for (const key of ['ArrowDown', 'End', 'Home', 'PageDown', ' ', 'a', 'ArrowRight']) fireEvent.keyDown(input(), { key });
    expect(onUnhandledKey).not.toHaveBeenCalled();
    expect(appKey).not.toHaveBeenCalled();
    expect(screen.getAllByRole('row')[0]).toHaveAttribute('aria-selected', 'true');
    document.removeEventListener('keydown', appKey);
  });

  it('Esc blurs (keeping the text) and returns focus to the graph; Enter blurs', () => {
    render(<GraphView graph={payload(wipRow('/r', null, { modified: 1 }))} repoId="/r" />);
    const grid = screen.getByRole('grid', { name: 'Commit graph' });
    input().focus();
    fireEvent.change(input(), { target: { value: 'keep me' } });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(document.activeElement).toBe(grid);
    expect(input().value).toBe('keep me');
    expect(readWipDraft('/r', '/r').summary).toBe('keep me');
    input().focus();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(document.activeElement).not.toBe(input());
  });
});
