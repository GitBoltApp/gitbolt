import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabState } from '../../api/gen/TabState';

// What the app's Esc looks at: the tab's open file and selection.
const view = vi.hoisted(() => ({ diff: null as unknown, selection: { kind: 'none' } as { kind: string } }));
vi.mock('../../app/tabStores', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app/tabStores')>()), tabStore: () => ({ getState: () => view }), useTabView: () => undefined }));

const { FlyoutHost } = await import('./FlyoutHost');
const { FlyoutFrame } = await import('./FlyoutFrame');
const { closeFlyout, DOCK_KEEP, DOCK_W, dockWidth, flyoutOf, openFlyout, registerFlyout, reloadDockPrefs, setDockPrefs, useFlyoutDock } = await import('./flyout');
const { EMPTY_PROFILE, useAppState } = await import('../../app/state');
const { closeCenterView, openCenterView, registerCenterView } = await import('../../repo/centerView');

const tab = { id: 't', kind: 'repo', path: '/r', alias: null } as TabState;
function Demo({ props, close }: { props: { text: string }; close(): void }) {
  return (
    <FlyoutFrame label="Demo panel" title="Demo" onClose={close}>
      <p>{props.text}</p>
      <textarea aria-label="Reply" />
    </FlyoutFrame>
  );
}
registerFlyout('demo', Demo);
function DockDemo({ props, close }: { props: { text: string }; close(): void }) {
  return (
    <FlyoutFrame label="Dock panel" title="Dock" onClose={close} headerActions={<button type="button" aria-label="Open in browser" />}>
      <p>{props.text}</p>
      <textarea aria-label="Reply" />
    </FlyoutFrame>
  );
}
registerFlyout('demo-dock', DockDemo, { dockable: true });
registerCenterView('demo-view', () => <section>view</section>);

const show = () => render(<div className="center-slot"><button type="button">Opener</button><FlyoutHost tab={tab} /></div>);
const esc = (el: Element) => fireEvent.keyDown(el, { key: 'Escape' });

beforeEach(() => {
  useAppState.setState({ profile: { ...EMPTY_PROFILE, flyoutWidth: null } });
  view.diff = null;
  view.selection = { kind: 'none' };
});
afterEach(() => {
  closeFlyout('t');
  closeCenterView('t');
});

describe('FlyoutHost (spec #4 §5)', () => {
  it('shows the open flyout with its props, focuses its heading, and × closes it back to the opener', () => {
    show();
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    act(() => openFlyout('t', 'demo', { text: 'hello' }));
    const panel = screen.getByRole('dialog', { name: 'Demo panel' });
    expect(panel).toHaveTextContent('hello');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Demo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(flyoutOf('t')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Esc inside it closes it; from outside only when the app's Esc has nothing to do", () => {
    show();
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    esc(screen.getByRole('textbox', { name: 'Reply' }));
    expect(flyoutOf('t')).toBeNull();
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    view.diff = { path: 'x' };
    esc(document.body);
    expect(flyoutOf('t')).not.toBeNull();
    view.diff = null;
    view.selection = { kind: 'compare' };
    esc(document.body);
    expect(flyoutOf('t')).not.toBeNull();
    view.selection = { kind: 'commit' };
    esc(document.body);
    expect(flyoutOf('t')).toBeNull();
  });

  it('is 560 px wide by default; its separator resizes it within bounds and resets', () => {
    show();
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    const host = document.querySelector<HTMLElement>('.flyout-host')!;
    expect(host.style.width).toBe('560px');
    const sep = screen.getByRole('separator', { name: 'Resize the panel' });
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(useAppState.getState().profile.flyoutWidth).toBe(576);
    fireEvent.keyDown(sep, { key: 'Enter' });
    expect(useAppState.getState().profile.flyoutWidth).toBeNull();
    act(() => useAppState.setState({ profile: { ...useAppState.getState().profile, flyoutWidth: 9999 } }));
    expect(host.style.width).toBe('760px');
  });

  it('hides while a center view is on top, and comes back', () => {
    show();
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    act(() => openCenterView('t', 'demo-view', {}));
    expect(screen.queryByRole('dialog', { name: 'Demo panel' })).toBeNull();
    act(() => closeCenterView('t'));
    expect(screen.getByRole('dialog', { name: 'Demo panel' })).toBeTruthy();
  });

  it('keeps focus where it was when a center view opens and closes over it', () => {
    show();
    const opener = screen.getByRole('button', { name: 'Opener' });
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    opener.focus();
    act(() => openCenterView('t', 'demo-view', {}));
    act(() => closeCenterView('t'));
    expect(document.activeElement).toBe(opener);
  });

  it('Esc from inside returns the focus to the opener', () => {
    show();
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    esc(screen.getByRole('textbox', { name: 'Reply' }));
    expect(document.activeElement).toBe(opener);
  });

  it("doesn't pull the focus back when it was outside at close", () => {
    show();
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    act(() => closeFlyout('t'));
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('a double-click on the separator resets the width', () => {
    show();
    act(() => useAppState.setState({ profile: { ...useAppState.getState().profile, flyoutWidth: 400 } }));
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize the panel' }));
    expect(useAppState.getState().profile.flyoutWidth).toBeNull();
  });

  it('is capped by the room: 240 px of the center stay beside it', () => {
    show();
    const parent = document.querySelector<HTMLElement>('.center-slot')!;
    Object.defineProperty(parent, 'clientWidth', { configurable: true, value: 700 });
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    expect(document.querySelector<HTMLElement>('.flyout-host')!.style.width).toBe('460px');
  });

  describe('docking beside the graph', () => {
    const host = () => document.querySelector<HTMLElement>('.flyout-host')!;
    const dockBtn = () => screen.getByRole('button', { name: /^(Dock beside the graph|Undock)/ });
    beforeEach(() => {
      localStorage.removeItem('gitbolt.flyoutDock.v1');
      reloadDockPrefs();
    });

    it('only a dockable flyout has the dock button, left of its other header buttons', () => {
      show();
      act(() => openFlyout('t', 'demo', { text: 'a' }));
      expect(screen.queryByRole('button', { name: 'Dock beside the graph' })).toBeNull();
      act(() => openFlyout('t', 'demo-dock', { text: 'a' }));
      const head = document.querySelector('.flyout-head')!;
      expect([...head.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Dock beside the graph', 'Open in browser', 'Close']);
    });

    it('the dock button docks it, then floats it again; the mode is remembered for the next one', () => {
      show();
      act(() => openFlyout('t', 'demo-dock', { text: 'a' }));
      expect(host()).not.toHaveClass('docked');
      fireEvent.mouseEnter(dockBtn());
      expect(screen.getByRole('tooltip')).toHaveTextContent('Dock beside the graph');
      fireEvent.click(dockBtn());
      expect(host()).toHaveClass('docked');
      expect(dockBtn()).toHaveAccessibleName('Undock (float over the graph)');
      expect(dockBtn()).toHaveAttribute('aria-pressed', 'true');
      expect(JSON.parse(localStorage.getItem('gitbolt.flyoutDock.v1')!)).toEqual({ docked: true, width: null });
      // The next one opens docked, also after a reload.
      act(() => closeFlyout('t'));
      act(() => reloadDockPrefs());
      act(() => openFlyout('t', 'demo-dock', { text: 'b' }));
      expect(host()).toHaveClass('docked');
      expect(host().style.width).toBe(`${DOCK_W.default}px`);
      // A flyout that can't dock still floats.
      act(() => openFlyout('t', 'demo', { text: 'c' }));
      expect(host()).not.toHaveClass('docked');
      act(() => openFlyout('t', 'demo-dock', { text: 'b' }));
      fireEvent.click(dockBtn());
      expect(host()).not.toHaveClass('docked');
      expect(useFlyoutDock.getState().docked).toBe(false);
    });

    it('docked, its separator sets the docked width (not the floating one), clamped so the graph keeps its room', () => {
      show();
      act(() => setDockPrefs({ docked: true }));
      act(() => openFlyout('t', 'demo-dock', { text: 'a' }));
      const sep = screen.getByRole('separator', { name: 'Resize the panel' });
      fireEvent.keyDown(sep, { key: 'ArrowRight' });
      expect(useFlyoutDock.getState().width).toBe(DOCK_W.default + 16);
      expect(useAppState.getState().profile.flyoutWidth).toBeNull();
      fireEvent.keyDown(sep, { key: 'Enter' });
      expect(useFlyoutDock.getState().width).toBeNull();
      expect(dockWidth(9999, 1200)).toBe(1200 - DOCK_KEEP);
      expect(dockWidth(100, 1200)).toBe(DOCK_W.min);
      expect(dockWidth(null, 2000)).toBe(DOCK_W.default);
      expect(dockWidth(9999, 2000)).toBe(DOCK_W.max);
    });

    it('in a center too narrow for both, it floats and the dock button says why', () => {
      show();
      const parent = document.querySelector<HTMLElement>('.center-slot')!;
      Object.defineProperty(parent, 'clientWidth', { configurable: true, value: DOCK_KEEP + DOCK_W.min - 1 });
      act(() => setDockPrefs({ docked: true }));
      act(() => openFlyout('t', 'demo-dock', { text: 'a' }));
      expect(host()).not.toHaveClass('docked');
      expect(dockBtn()).toBeDisabled();
      fireEvent.mouseEnter(dockBtn());
      expect(screen.getByRole('tooltip')).toHaveTextContent('The window is too narrow to dock');
      // Just wide enough: docked, at the narrowest.
      Object.defineProperty(parent, 'clientWidth', { configurable: true, value: DOCK_KEEP + DOCK_W.min });
      act(() => { closeFlyout('t'); });
      act(() => openFlyout('t', 'demo-dock', { text: 'a' }));
      expect(host()).toHaveClass('docked');
      expect(host().style.width).toBe(`${DOCK_W.min}px`);
    });

    it('docked, Esc closes it only with the focus inside it', () => {
      show();
      act(() => setDockPrefs({ docked: true }));
      act(() => openFlyout('t', 'demo-dock', { text: 'a' }));
      view.selection = { kind: 'commit' };
      esc(document.body);
      esc(screen.getByRole('button', { name: 'Opener' }));
      expect(flyoutOf('t')).not.toBeNull();
      esc(screen.getByRole('textbox', { name: 'Reply' }));
      expect(flyoutOf('t')).toBeNull();
    });
  });

  it('drops its drag listeners when it unmounts mid-drag', () => {
    const rm = vi.spyOn(window, 'removeEventListener');
    const { unmount } = show();
    act(() => openFlyout('t', 'demo', { text: 'a' }));
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize the panel' }), { clientX: 10 });
    unmount();
    expect(rm).toHaveBeenCalledWith('pointermove', expect.any(Function));
    rm.mockRestore();
  });
});
