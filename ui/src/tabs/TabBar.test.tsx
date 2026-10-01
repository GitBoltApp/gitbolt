import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: { openIn: vi.fn(async () => null), saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null), appInfo: vi.fn(async () => ({ appVersion: 'x', gitVersion: 'y' })) },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { useAppState, EMPTY_PROFILE } = await import('../app/state');
const { TabBar } = await import('./TabBar');
const { useTabUi } = await import('./tabMenu');

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

describe('TabBar: rename field', () => {
  afterEach(() => {
    useTabUi.getState().stopRename();
    useAppState.setState({ profile: EMPTY_PROFILE });
  });
  const start = () => {
    setTabs(['a', 'b'], 'a');
    render(<TabBar />);
    act(() => useTabUi.getState().startRename('b'));
    return screen.getByLabelText('Tab name') as HTMLInputElement;
  };

  it('clicking inside the field keeps editing and does not switch tabs', () => {
    const input = start();
    fireEvent.pointerDown(input, { button: 0 });
    fireEvent.mouseDown(input, { button: 0 });
    fireEvent.click(input);
    fireEvent.doubleClick(input);
    expect(screen.getByLabelText('Tab name')).toBe(input);
    expect(useAppState.getState().profile.activeTab).toBe('a');
  });

  it('Shift+Arrow, Home/End and Space stay in the field (focus stays, default not prevented)', () => {
    const input = start();
    input.focus();
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', ' ']) {
      const notPrevented = fireEvent.keyDown(input, { key, shiftKey: key.startsWith('Arrow') });
      expect(notPrevented).toBe(true);
      expect(screen.getByLabelText('Tab name')).toBe(input);
      expect(document.activeElement).toBe(input);
    }
    expect(useAppState.getState().profile.activeTab).toBe('a');
  });

  it('Enter commits the alias', () => {
    const input = start();
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByLabelText('Tab name')).toBeNull();
    expect(useAppState.getState().profile.tabs[1].alias).toBe('Backend');
  });

  it('Esc cancels without renaming (and a later blur does not commit)', () => {
    const input = start();
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(screen.queryByLabelText('Tab name')).toBeNull();
    expect(useAppState.getState().profile.tabs[1].alias).toBeNull();
  });

  it('a blur (click outside) commits', () => {
    const input = start();
    fireEvent.change(input, { target: { value: 'Blurred' } });
    fireEvent.blur(input);
    expect(useAppState.getState().profile.tabs[1].alias).toBe('Blurred');
  });
});
