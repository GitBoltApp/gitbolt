import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';

vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));
// The avatar-only author cell renders 1B's Avatar; stubbed here (no avatar store traffic).
vi.mock('../avatars/Avatar', () => ({ Avatar: ({ name }: { name: string }) => <span data-testid="avatar" data-name={name} /> }));

import { useMenu } from '../menu/menuStore';
import { DEFAULT_DENSITY, useDensity } from '../theme/density';
import { COLUMN_MIN, lanesWidth, useColumnPrefs } from './columns';
import { graphLayout } from './draw';
import { GraphView } from './GraphView';
import { METRICS } from './metrics';

// A recording 2D context: what the canvas was last asked to draw.
const calls: string[] = [];
beforeAll(() => {
  const gradient = { addColorStop: () => {} };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => { calls.push(`${k}(${a.map((x) => (typeof x === 'number' ? x : typeof x)).join(',')})`); return k === 'createLinearGradient' ? gradient : undefined; }),
    set: (t, k: string, v) => { t[k] = v; return true; },
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
});

const row = (i: number, lane: number) => ({ id: String(i).padStart(40, '0'), kind: 'commit' as const, lane, color: lane, segments: [], summary: `c${i}`, bodyFirstLine: '', authorName: 'Ada Lovelace', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graph: GraphPayload = {
  rows: [row(0, 0), row(1, 5)],
  labels: [{ row: 0, name: 'main', local: 'refs/heads/main', remotes: [], tag: false, isHead: true, worktree: null, checkedOut: null }],
  maxLanes: 6, pinnedRefs: [], head: { branch: 'refs/heads/main', target: '0'.repeat(40), detached: false, unborn: false }, truncated: false, worktrees: [],
};
const need = lanesWidth(6, METRICS);
const cell = (col: string, r = 0) => screen.getAllByRole('row')[r].querySelector<HTMLElement>(`[data-col="${col}"]`);
const header = (col: string) => document.querySelector<HTMLElement>(`.graph-header [data-col="${col}"]`);
/** Prefs for '/r' (the repo mounted below), so GraphView's loadFor keeps them. */
const prefs = (p: Partial<ReturnType<typeof useColumnPrefs.getState>['prefs']>) => {
  useColumnPrefs.getState().loadFor('/r');
  useColumnPrefs.setState((s) => ({ prefs: { ...s.prefs, ...p } }));
};

beforeEach(() => {
  useDensity.setState({ density: DEFAULT_DENSITY });
  useColumnPrefs.getState().reset();
  calls.length = 0;
});
afterEach(() => act(() => useMenu.getState().close()));

describe('collapsed columns (spec §8.4)', () => {
  it('a column at its minimum shows an icon in its header (the title in its tooltip); SHA keeps its text', () => {
    prefs({ labels: COLUMN_MIN.labels, author: COLUMN_MIN.author, graph: COLUMN_MIN.graph });
    render(<GraphView graph={graph} repoId="/r" />);
    for (const name of ['Branch / Tag', 'Author', 'Graph']) expect(screen.getByRole('img', { name })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Commit date / time' })).toBeNull();
    expect(header('date')).toHaveTextContent('COMMIT DATE / TIME');
    expect(header('sha')).toHaveTextContent('SHA');
    expect(header('labels')).not.toHaveTextContent('BRANCH');
  });

  it('at its minimum, Branch/Tag shows icon-only chips (the name comes back in the hover copy)', () => {
    prefs({ labels: COLUMN_MIN.labels });
    render(<GraphView graph={graph} repoId="/r" />);
    const chip = cell('labels')!.querySelector('.ref-label')!;
    expect(chip).toHaveClass('compact');
    expect(chip.querySelector('.ref-name')).toBeNull();
    expect(within(chip as HTMLElement).getByLabelText('HEAD')).toBeInTheDocument();
    expect(within(chip as HTMLElement).getByLabelText('local')).toBeInTheDocument();
    fireEvent.mouseEnter(chip);
    expect(chip.querySelector('.ref-label-full')).toHaveTextContent('main');
    // The connector still runs to the canvas.
    expect(cell('labels')!.querySelector('.ref-connector')).not.toBeNull();
  });

  it('at its minimum, Author shows only the avatar', () => {
    prefs({ author: COLUMN_MIN.author });
    render(<GraphView graph={graph} repoId="/r" />);
    expect(within(cell('author')!).getByTestId('avatar')).toHaveAttribute('data-name', 'Ada Lovelace');
    expect(cell('author')).not.toHaveTextContent('Ada');
  });

  it('above their minimums, headers and cells are the full ones', () => {
    render(<GraphView graph={graph} repoId="/r" />);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(cell('author')).toHaveTextContent('Ada Lovelace');
    expect(cell('labels')!.querySelector('.ref-label')).not.toHaveClass('compact');
  });
});

describe('hidden columns (spec §8.4)', () => {
  it('the header menu hides and shows every column but Graph and Message', () => {
    render(<GraphView graph={graph} repoId="/r" />);
    fireEvent.contextMenu(document.querySelector('.graph-header')!, { clientX: 10, clientY: 10 });
    const labels = () => useMenu.getState().rows!.flatMap((r) => (r.kind === 'action' ? [r.label] : []));
    expect(labels()).toEqual(['Hide Branch / Tag', 'Hide Author', 'Hide Commit date / time', 'Hide SHA']);
    const run = (label: string) => act(() => (useMenu.getState().rows!.find((r) => r.kind === 'action' && r.label === label) as { run(): void }).run());
    run('Hide Author');
    expect(header('author')).toBeNull();
    expect(cell('author')).toBeNull();
    // Each handle resizes its own column: Message's stays.
    expect(screen.getByRole('separator', { name: /Commit message/ })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: /Date/ })).toBeInTheDocument();
    fireEvent.contextMenu(document.querySelector('.graph-header')!, { clientX: 10, clientY: 10 });
    expect(labels()).toContain('Show Author');
    run('Show Author');
    expect(cell('author')).toHaveTextContent('Ada Lovelace');
  });

  it('the menu key or Shift+F10 on a header control opens the same menu (keyboard)', () => {
    render(<GraphView graph={graph} repoId="/r" />);
    fireEvent.keyDown(screen.getByRole('separator', { name: /Branch/ }), { key: 'F10', shiftKey: true });
    expect(useMenu.getState().rows?.[0]).toMatchObject({ label: 'Hide Branch / Tag' });
    act(() => useMenu.getState().close());
    fireEvent.keyDown(screen.getByRole('separator', { name: /Date/ }), { key: 'ContextMenu' });
    expect(useMenu.getState().rows).toHaveLength(4);
    act(() => useMenu.getState().close());
    // Plain F10, or arrows (the handle's own keys), open nothing.
    fireEvent.keyDown(screen.getByRole('separator', { name: /Date/ }), { key: 'F10' });
    fireEvent.keyDown(screen.getByRole('separator', { name: /Date/ }), { key: 'ArrowLeft' });
    expect(useMenu.getState().rows).toBeNull();
  });

  it('with Branch/Tag hidden the canvas starts at the left edge and draws no label connectors', () => {
    act(() => {
      useColumnPrefs.getState().loadFor('/r');
      useColumnPrefs.getState().toggleHidden('labels');
    });
    render(<GraphView graph={graph} repoId="/r" />);
    expect(cell('labels')).toBeNull();
    expect(screen.getByTestId('graph-canvas')).toHaveStyle({ left: '0px' });
    expect(calls.some((c) => c.startsWith('moveTo(0,'))).toBe(false);
  });
});

describe('the Graph column narrowed below its lanes (F11)', () => {
  it('gets its own lane scrollbar over the lane area; scrolling it shifts the lanes', () => {
    prefs({ graph: 120 });
    render(<GraphView graph={graph} repoId="/r" />);
    const { area } = graphLayout(120, METRICS, true);
    const bar = screen.getByRole('scrollbar', { name: 'Scroll lanes' });
    const canvas = screen.getByTestId('graph-canvas');
    expect(bar).toHaveAttribute('aria-controls', canvas.id);
    expect(canvas.id).not.toBe('');
    expect(bar).toHaveAttribute('aria-orientation', 'horizontal');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', String(need - area));
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    // Under the Graph column (Branch/Tag is 200 px), across its lane area only (not the zone).
    expect(bar).toHaveStyle({ left: '200px', width: `${area}px` });
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${need}px`);
    calls.length = 0;
    bar.scrollLeft = 40;
    fireEvent.scroll(bar);
    expect(calls).toContain('translate(-40,0)');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
  });

  it('none while the lanes fit, and none at the minimum width (the strip)', () => {
    const { unmount } = render(<GraphView graph={graph} repoId="/r" />);
    expect(screen.queryByLabelText('Scroll lanes')).toBeNull();
    unmount();
    prefs({ graph: COLUMN_MIN.graph });
    render(<GraphView graph={graph} repoId="/r" />);
    expect(screen.getByTestId('graph-canvas')).toHaveAttribute('data-strip', 'true');
    expect(screen.queryByLabelText('Scroll lanes')).toBeNull();
  });
});
