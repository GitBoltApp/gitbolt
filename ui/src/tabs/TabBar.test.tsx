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

describe('TabBar: the settings gear (K102)', () => {
  it('sits left of the profile button and runs the settings action', async () => {
    const { registerActions } = await import('../app/actions');
    const run = vi.fn();
    const off = registerActions([{ id: 'file.settings', label: 'Settings', group: 'File', icon: (() => null) as never, tooltip: 't', run }]);
    setTabs(['a'], 'a');
    render(<TabBar />);
    const gear = screen.getByRole('button', { name: 'Settings' });
    expect(gear.parentElement?.nextElementSibling ?? gear.nextElementSibling).toBeTruthy();
    fireEvent.click(gear);
    expect(run).toHaveBeenCalled();
    off();
  });
});

describe('TabBar: live drag reordering (spec §6.2)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); useAppState.setState({ profile: EMPTY_PROFILE }); });
  // Three 100 px tabs at 0, 100, 200 in a 600 px strip (jsdom has no layout).
  const layout = () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isTab = this.getAttribute('role') === 'tab';
      const left = isTab ? [...(this.parentElement?.children ?? [])].indexOf(this) * 100 : 0;
      const width = isTab ? 100 : 600;
      return { left, right: left + width, width, top: 0, bottom: 30, height: 30, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    });
  };
  const ids = () => useAppState.getState().profile.tabs.map((t) => t.id);
  const moveTo = (clientX: number) => act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX })); });
  const release = (clientX: number) => act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientX })); });

  it('the others slide aside while dragging; a release slides into the slot, then commits', () => {
    vi.useFakeTimers();
    setTabs(['a', 'b', 'c'], 'a');
    render(<TabBar />);
    layout();
    const tabs = screen.getAllByRole('tab');
    fireEvent.pointerDown(tabs[0], { button: 0, clientX: 50 });
    moveTo(52); // under the threshold: nothing moves
    expect(tabs[0].style.transform).toBe('');
    moveTo(160); // right edge at 210: past b's midpoint (150), not c's (250)
    expect(tabs[0].style.transform).toBe('translateX(110px)');
    expect(tabs[1].style.transform).toBe('translateX(-100px)');
    expect(tabs[2].style.transform).toBe('');
    release(160);
    expect(tabs[0].style.transform).toBe('translateX(100px)'); // sliding into its slot
    expect(ids()).toEqual(['a', 'b', 'c']);
    act(() => { vi.advanceTimersByTime(150); });
    expect(ids()).toEqual(['b', 'a', 'c']);
    for (const t of screen.getAllByRole('tab')) expect(t.style.transform).toBe('');
  });

  it('Esc cancels: everything slides back and the order is unchanged', () => {
    vi.useFakeTimers();
    setTabs(['a', 'b', 'c'], 'a');
    render(<TabBar />);
    layout();
    const tabs = screen.getAllByRole('tab');
    fireEvent.pointerDown(tabs[2], { button: 0, clientX: 250 });
    moveTo(20);
    expect(tabs[0].style.transform).toBe('translateX(100px)');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    for (const t of tabs) expect(t.style.transform).toBe('');
    moveTo(0); // the drag is over: later moves do nothing
    release(0);
    act(() => { vi.advanceTimersByTime(150); });
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(screen.getByRole('tablist').classList.contains('reordering')).toBe(false);
  });

  it('a click (no movement past the threshold) still activates the tab', () => {
    setTabs(['a', 'b'], 'a');
    render(<TabBar />);
    layout();
    const b = screen.getAllByRole('tab')[1];
    fireEvent.pointerDown(b, { button: 0, clientX: 150 });
    moveTo(152);
    release(152);
    fireEvent.click(b);
    expect(useAppState.getState().profile.activeTab).toBe('b');
  });
});
