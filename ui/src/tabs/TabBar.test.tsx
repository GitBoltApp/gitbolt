import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: { openIn: vi.fn(async () => null), saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null), appInfo: vi.fn(async () => ({ appVersion: 'x', gitVersion: 'y' })) },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { useAppState, EMPTY_PROFILE } = await import('../app/state');
const { TabBar } = await import('./TabBar');

const tab = (id: string) => ({ id, kind: 'repo' as const, path: `/${id}`, alias: null });

function setTabs(ids: string[], active: string) {
  act(() => {
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: ids.map(tab), activeTab: active } });
  });
}

describe('TabBar: roving tabindex (spec §6.2)', () => {
  afterEach(() => { useAppState.setState({ profile: EMPTY_PROFILE }); });

  it('only the active tab sits in the page Tab order', () => {
    setTabs(['a', 'b', 'c'], 'b');
    render(<TabBar />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    // The close button isn't a separate Tab stop (one stop per tab strip).
    for (const t of tabs) expect(t.querySelector('.tab-close')).toHaveProperty('tabIndex', -1);
  });

  it('ArrowRight/ArrowLeft move focus and wrap; Home/End jump to the ends', () => {
    setTabs(['a', 'b', 'c'], 'a');
    render(<TabBar />);
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' }); // wraps past the start
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(document.activeElement).toBe(tabs[2]);
  });

  it('Enter (or Space) activates the focused tab, without changing which one is active until then', () => {
    setTabs(['a', 'b', 'c'], 'a');
    render(<TabBar />);
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' }); // focus moves to b; a is still active
    expect(useAppState.getState().profile.activeTab).toBe('a');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(useAppState.getState().profile.activeTab).toBe('b');
  });
});
