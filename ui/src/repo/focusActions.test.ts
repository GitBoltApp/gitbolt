import { describe, expect, it } from 'vitest';
import { actionForCombo, runAction } from '../app/actions';
import { useAppState } from '../app/state';
import { activeTabWith } from '../app/testShell';
import type { DiffTarget, PanelContent } from './store';
import './focusActions';

const target = { key: 'k|a.txt', path: 'a.txt', oldPath: null, status: 'M', old: { kind: 'absent' }, new: { kind: 'absent' }, view: 'diff' } as DiffTarget;
const panel = { selection: { kind: 'commit', index: 0, id: 'abc' }, parent: 0, sections: [] } as unknown as PanelContent;

describe('the focus keys: Alt+1 sidebar, Alt+2 graph, Alt+3 file list, Alt+4 diff', () => {
  it('move the keyboard to the zone', () => {
    const store = activeTabWith();
    store.setState({ panel, selection: panel.selection, diff: target });
    for (const [combo, zone] of [['Alt+3', 'files'], ['Alt+4', 'diff']] as const) {
      const before = store.getState().focusRequest;
      expect(runAction(actionForCombo(combo)!.id)).toBe(true);
      expect(store.getState().focus).toBe(zone);
      expect(store.getState().focusRequest).toBeGreaterThan(before);
    }
  });

  it('the graph, with a file open over it, closes the file (as Esc does)', () => {
    const store = activeTabWith();
    store.setState({ diff: target });
    runAction(actionForCombo('Alt+2')!.id);
    expect(store.getState()).toMatchObject({ diff: null, focus: 'graph' });
    runAction(actionForCombo('Alt+2')!.id);
    expect(store.getState().focus).toBe('graph');
  });

  it('the sidebar, expanded from its icon strip', () => {
    const store = activeTabWith();
    useAppState.setState((s) => ({ profile: { ...s.profile, sidebarNarrow: true } }));
    store.setState({ focus: 'graph' });
    runAction(actionForCombo('Alt+1')!.id);
    expect(useAppState.getState().profile.sidebarNarrow).toBe(false);
    expect(store.getState().focus).toBe('sidebar');
  });

  it('the file list and the diff only when they show', () => {
    activeTabWith();
    expect(actionForCombo('Alt+3')).toBeUndefined();
    expect(actionForCombo('Alt+4')).toBeUndefined();
  });
});
