import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabGroup } from '../api/gen/TabGroup';
import { WHEEL_LINE_PX, wheelDelta } from './stripScroll';

vi.mock('../api/client', () => ({
  api: { openIn: vi.fn(async () => null), saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null), appInfo: vi.fn(async () => ({ appVersion: 'x', gitVersion: 'y' })) },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { useAppState, EMPTY_PROFILE } = await import('../app/state');
const { activateTab, cycleTab } = await import('../app/tabs');
const { toggleGroupCollapsed } = await import('../app/tabGroups');
const { TabBar } = await import('./TabBar');

describe('wheelDelta', () => {
  it('a vertical wheel scrolls sideways: down goes right, up goes left', () => {
    expect(wheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 500)).toBe(100);
    expect(wheelDelta({ deltaX: 0, deltaY: -100, deltaMode: 0 }, 500)).toBe(-100);
  });

  it('a horizontal wheel (thumb wheel, trackpad, Shift+wheel) passes through; the larger axis wins', () => {
    expect(wheelDelta({ deltaX: -60, deltaY: 0, deltaMode: 0 }, 500)).toBe(-60);
    expect(wheelDelta({ deltaX: 30, deltaY: 4, deltaMode: 0 }, 500)).toBe(30);
    expect(wheelDelta({ deltaX: 4, deltaY: -30, deltaMode: 0 }, 500)).toBe(-30);
  });

  it('lines and pages are converted to px', () => {
    expect(wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 500)).toBe(3 * WHEEL_LINE_PX);
    expect(wheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 500)).toBe(-500);
  });
});

const tab = (id: string) => ({ id, kind: 'repo' as const, path: `/${id}`, alias: null });
const setTabs = (ids: string[], active: string, tabGroups: TabGroup[] = []) =>
  act(() => { useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: ids.map(tab), activeTab: active, tabGroups } }); });
const update = (fn: Parameters<ReturnType<typeof useAppState.getState>['updateProfile']>[0]) => act(() => { useAppState.getState().updateProfile(fn); });

/** jsdom has no layout: a strip 300 px wide over 1000 px of tabs, its scrollLeft a plain field. */
function overflowing(strip: HTMLElement, scrollWidth = 1000) {
  let left = 0;
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 });
  Object.defineProperty(strip, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => { left = v; } });
}

const wheel = (el: Element, init: WheelEventInit) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};

describe('TabBar: the strip scrolls under the wheel', () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAppState.setState({ profile: EMPTY_PROFILE });
  });
  const settle = () => { for (let i = 0; i < 50 && frames.length; i++) frames.shift()!(performance.now()); };

  it('down scrolls right and up left, gliding to where the notches add up, clamped to the ends', () => {
    setTabs(['a', 'b', 'c'], 'a');
    render(<TabBar />);
    const strip = screen.getByRole('tablist');
    overflowing(strip);
    expect(wheel(strip, { deltaY: 100 }).defaultPrevented).toBe(true);
    wheel(strip, { deltaY: 100 }); // a second notch before the first has landed adds up
    settle();
    expect(strip.scrollLeft).toBe(200);
    wheel(strip, { deltaY: -50 });
    settle();
    expect(strip.scrollLeft).toBe(150);
    wheel(strip, { deltaX: 5000 }); // a horizontal wheel too, clamped
    settle();
    expect(strip.scrollLeft).toBe(700);
    wheel(strip, { deltaY: -3, deltaMode: 1 });
    settle();
    expect(strip.scrollLeft).toBe(700 - 3 * WHEEL_LINE_PX);
  });

  it('a strip that fits leaves the wheel alone, and so is Ctrl+wheel (zoom)', () => {
    setTabs(['a'], 'a');
    render(<TabBar />);
    const strip = screen.getByRole('tablist');
    overflowing(strip, 300);
    expect(wheel(strip, { deltaY: 100 }).defaultPrevented).toBe(false);
    overflowing(strip);
    expect(wheel(strip, { deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(false);
    settle();
    expect(strip.scrollLeft).toBe(0);
  });

  it('reduced motion: no glide', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    try {
      setTabs(['a', 'b'], 'a');
      render(<TabBar />);
      const strip = screen.getByRole('tablist');
      overflowing(strip);
      wheel(strip, { deltaY: 120 });
      expect(strip.scrollLeft).toBe(120);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('TabBar: the active tab is scrolled into view', () => {
  let revealed: string[];
  let options: unknown[];
  beforeEach(() => {
    revealed = [];
    options = [];
    Element.prototype.scrollIntoView = function (this: Element, o?: boolean | ScrollIntoViewOptions) {
      revealed.push((this as HTMLElement).dataset.tabId ?? '?');
      options.push(o);
    };
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
    useAppState.setState({ profile: EMPTY_PROFILE });
  });

  it('at launch and on every activation through the store (not only clicks), along the strip only', () => {
    setTabs(['a', 'b', 'c', 'd'], 'a');
    render(<TabBar />);
    expect(revealed).toEqual(['a']);
    update((p) => cycleTab(p, 1)); // Ctrl+Tab
    update((p) => activateTab(p, 'd')); // Ctrl+4, paste-to-go, a close's neighbour
    update((p) => ({ ...p, tabs: [...p.tabs, tab('e')], activeTab: 'e' })); // a new tab
    expect(revealed).toEqual(['a', 'b', 'd', 'e']);
    expect(options.every((o) => JSON.stringify(o) === JSON.stringify({ inline: 'nearest', block: 'nearest' }))).toBe(true);
    // A click goes through the store too.
    fireEvent.click(screen.getByText('a'));
    expect(revealed.at(-1)).toBe('a');
  });

  it('a group expanding reveals the active tab again, and again once the tabs have grown in', () => {
    setTabs(['a', 'b', 'c'], 'c', [{ id: 'g', name: '', color: 'blue', collapsed: true, tabs: ['a', 'b'] }]);
    render(<TabBar />);
    revealed.length = 0;
    update((p) => toggleGroupCollapsed(p, 'g'));
    expect(revealed).toEqual(['c']);
    const strip = screen.getByRole('tablist');
    const grown = new Event('transitionend', { bubbles: true }) as TransitionEvent;
    Object.defineProperty(grown, 'propertyName', { value: 'width' });
    act(() => { strip.querySelector('[data-tab-id="a"]')!.dispatchEvent(grown); });
    expect(revealed).toEqual(['c', 'c']);
    // The wheel takes over: a later slide no longer pulls the strip back.
    overflowing(strip);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    try {
      wheel(strip, { deltaY: 100 });
      act(() => { strip.querySelector('[data-tab-id="a"]')!.dispatchEvent(grown); });
      expect(revealed).toEqual(['c', 'c']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
