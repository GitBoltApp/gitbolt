import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: { lastPush: vi.fn(async () => null) }, errorMessage: String, onEvent: () => () => {} }));

const { runAction, actionForCombo } = await import('../app/actions');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { EMPTY_GRAPH } = await import('../app/testShell');
const { useTabViews } = await import('../app/tabStores');
const { centerViewOf, closeCenterView, openCenterView, registerCenterView } = await import('../repo/centerView');
const { createRepoViewStore } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');
await import('./actions');

const narrow = () => useAppState.getState().profile.sidebarNarrow;
registerCenterView('a-plan', () => null, { sidebar: 'hide' });
registerCenterView('a-file', () => null);

describe('the sidebar actions around center views (UX R2)', () => {
  beforeEach(() => {
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
    useTabViews.setState({ views: { t: { repo: 4, services: fakeServices(), store: createRepoViewStore(4, '/r', EMPTY_GRAPH, fakeServices()) } } });
  });
  afterEach(() => { closeCenterView('t'); useTabViews.setState({ views: {} }); });

  it('Ctrl+B and Ctrl+Alt+F stand aside while the rebase editor hides the sidebar: the stored setting stays', () => {
    openCenterView('t', 'a-plan', {});
    expect(actionForCombo('Ctrl+B')).toBeUndefined();
    expect(actionForCombo('Ctrl+Alt+F')).toBeUndefined();
    expect(runAction('view.toggleSidebar')).toBe(false);
    expect(runAction('edit.filterSidebar')).toBe(false);
    expect(narrow()).toBe(false);
    closeCenterView('t');
    expect(runAction('view.toggleSidebar')).toBe(true);
    expect(narrow()).toBe(true);
  });

  it('over a file view, Ctrl+B is the strip\'s (>): it leaves the view, expanded', () => {
    useAppState.getState().updateProfile((p) => ({ ...p, sidebarNarrow: true }));
    openCenterView('t', 'a-file', {});
    expect(runAction('view.toggleSidebar')).toBe(true);
    expect(centerViewOf('t')).toBeNull();
    expect(narrow()).toBe(false);
  });
});
