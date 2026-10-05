import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

// The tab's graph: what it has loaded, and its selection.
const graph = vi.hoisted(() => ({ selectCommitById: vi.fn((_id: string) => true), setFocus: vi.fn() }));
const view = create(() => ({ indexById: new Map<string, number>([['a1f3c9e00', 3]]), ...graph }));
vi.mock('../../app/tabStores', () => ({ useTabView: () => ({ store: view }), tabStore: () => view }));
const history = vi.hoisted(() => ({ recordPlace: vi.fn() }));
vi.mock('../../nav/history', () => history);

const { useCommitJump } = await import('./commitJump');

beforeEach(() => vi.clearAllMocks());

describe('useCommitJump', () => {
  it('selects a loaded commit in the graph (the focus goes there), recorded as a navigation place first', () => {
    const { result } = renderHook(() => useCommitJump('t'));
    expect(result.current.inGraph('a1f3c9e00')).toBe(true);
    result.current.open('a1f3c9e00');
    expect(history.recordPlace).toHaveBeenCalledWith('t', { kind: 'commit', sha: 'a1f3c9e00' });
    expect(graph.selectCommitById).toHaveBeenCalledWith('a1f3c9e00');
    expect(graph.setFocus).toHaveBeenCalledWith('graph');
    expect(history.recordPlace.mock.invocationCallOrder[0]).toBeLessThan(graph.selectCommitById.mock.invocationCallOrder[0]!);
  });

  it("does nothing for one the graph hasn't loaded, and follows the graph as it reloads", () => {
    const { result } = renderHook(() => useCommitJump('t'));
    expect(result.current.inGraph('7be2d1000')).toBe(false);
    result.current.open('7be2d1000');
    expect(graph.selectCommitById).not.toHaveBeenCalled();
    expect(history.recordPlace).not.toHaveBeenCalled();
    act(() => view.setState({ indexById: new Map([['7be2d1000', 0]]) }));
    expect(result.current.inGraph('7be2d1000')).toBe(true);
  });
});
