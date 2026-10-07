import { describe, expect, it } from 'vitest';
import { actionForCombo, runAction } from './actions';
import { EMPTY_PROFILE, useAppState } from './state';
import './coreActions';

const tabs = (n: number) => useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, kind: 'repo' as const, path: `/r${i + 1}`, alias: null })), activeTab: 't1' } });
const active = () => useAppState.getState().profile.activeTab;

describe('Ctrl+1…8: that tab; Ctrl+9: the last one (as in browsers)', () => {
  it('switch tabs', () => {
    tabs(3);
    runAction(actionForCombo('Ctrl+3')!.id);
    expect(active()).toBe('t3');
    runAction(actionForCombo('Ctrl+1')!.id);
    expect(active()).toBe('t1');
    runAction(actionForCombo('Ctrl+9')!.id);
    expect(active()).toBe('t3');
  });

  it('a tab that isn\'t there takes no key', () => {
    tabs(3);
    expect(actionForCombo('Ctrl+4')).toBeUndefined();
    tabs(1);
    expect(actionForCombo('Ctrl+9')).toBeUndefined();
  });
});
