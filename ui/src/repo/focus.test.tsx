import { fireEvent, render, screen } from '@testing-library/react';
import { act, useRef } from 'react';
import { describe, expect, it } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { useFocusZone } from './focus';
import { createRepoViewStore, RepoViewContext, type FocusZone } from './store';
import { fakeServices } from './testServices';

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };

function Zone({ zone, inner }: { zone: FocusZone; inner?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const props = useFocusZone(zone, ref, inner ? '[role="listbox"]' : undefined);
  return (
    <div ref={ref} tabIndex={-1} data-testid={zone} {...props}>
      {inner && <div role="listbox" tabIndex={0} aria-label={`${zone} list`} />}
    </div>
  );
}

describe('focus zones', () => {
  it('store focus moves DOM focus, and DOM focus moves the store', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    render(<RepoViewContext value={store}><Zone zone="graph" /><Zone zone="files" inner /></RepoViewContext>);
    expect(screen.getByTestId('graph')).toHaveFocus();
    expect(screen.getByTestId('graph')).toHaveAttribute('data-zone-focused', 'true');
    act(() => store.getState().setFocus('files'));
    expect(screen.getByRole('listbox', { name: 'files list' })).toHaveFocus();
    fireEvent.focus(screen.getByTestId('graph'));
    expect(store.getState().focus).toBe('graph');
  });

  // Review fix 2: the store's focus can be stale (it follows DOM focus-in only), so a request for
  // the zone it already names (plan 1C's palette "focus graph") must still move DOM focus.
  it('setFocus re-focuses a zone whose store focus is stale', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    render(<RepoViewContext value={store}><Zone zone="graph" /><button type="button">outside</button></RepoViewContext>);
    expect(screen.getByTestId('graph')).toHaveFocus();
    screen.getByRole('button', { name: 'outside' }).focus();
    expect(store.getState().focus).toBe('graph');
    act(() => store.getState().setFocus('graph'));
    expect(screen.getByTestId('graph')).toHaveFocus();
  });
});
