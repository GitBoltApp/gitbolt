import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabState } from '../../api/gen/TabState';

// What the app's Esc looks at: the tab's open file and selection.
const view = vi.hoisted(() => ({ diff: null as unknown, selection: { kind: 'none' } as { kind: string } }));
vi.mock('../../app/tabStores', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app/tabStores')>()), tabStore: () => ({ getState: () => view }), useTabView: () => undefined }));

const { FlyoutHost } = await import('./FlyoutHost');
const { FlyoutFrame } = await import('./FlyoutFrame');
const { closeFlyout, flyoutOf, openFlyout, registerFlyout } = await import('./flyout');
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
