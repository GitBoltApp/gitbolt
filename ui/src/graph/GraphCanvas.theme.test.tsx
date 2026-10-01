import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowPayload } from '../api/gen/RowPayload';
import { useTheme } from '../theme/store';
import { THEMES } from '../theme/themes';
import { drawGraph } from './draw';
import { GraphCanvas } from './GraphCanvas';
import { METRICS } from './metrics';

vi.mock('./draw', async (importOriginal) => ({ ...(await importOriginal<typeof import('./draw')>()), drawGraph: vi.fn() }));
// A non-null context so GraphCanvas gets as far as calling drawGraph.
HTMLCanvasElement.prototype.getContext = (() => ({})) as never;

const rows: RowPayload[] = [
  { id: 'a'.repeat(40), kind: 'commit', lane: 0, color: 0, segments: [], summary: '', bodyFirstLine: '', authorName: 'Ada Lovelace', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null },
];

describe('GraphCanvas theme changes', () => {
  beforeEach(() => {
    act(() => useTheme.getState().set('default-dark', {}));
    vi.mocked(drawGraph).mockClear();
  });

  it("redraws with the new theme's node fill and lanes", () => {
    render(<GraphCanvas rows={rows} scrollTop={0} width={100} height={50} left={0} metrics={METRICS} labeledRows={new Set()} />);
    const first = vi.mocked(drawGraph).mock.lastCall![1];
    expect(first.nodeFill).toBe('#1c1e23');
    expect(first.nodeText).toBe('#ffffff');
    expect(first.stripColor).toBe('rgba(0, 0, 0, 0.4)');
    expect(first.colors).toEqual(THEMES['default-dark'].graph);
    act(() => useTheme.getState().set('light', {}));
    const o = vi.mocked(drawGraph).mock.lastCall![1];
    expect(o.nodeFill).toBe(THEMES.light.colors['node-fill']);
    expect(o.nodeText).toBe(THEMES.light.colors['node-text']);
    expect(o.stripColor).toBe(THEMES.light.colors['collapse-strip']);
    expect(o.colors).toEqual(THEMES.light.graph);
  });

  it('redraws when only a lane override changes', () => {
    render(<GraphCanvas rows={rows} scrollTop={0} width={100} height={50} left={0} metrics={METRICS} labeledRows={new Set()} />);
    const calls = vi.mocked(drawGraph).mock.calls.length;
    act(() => useTheme.getState().set('default-dark', { 'default-dark': ['#123456'] }));
    expect(vi.mocked(drawGraph).mock.calls.length).toBeGreaterThan(calls);
    expect(vi.mocked(drawGraph).mock.lastCall![1].colors[0]).toBe('#123456');
  });
});
