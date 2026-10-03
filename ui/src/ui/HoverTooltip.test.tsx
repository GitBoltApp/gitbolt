import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverTooltip } from './HoverTooltip';

describe('HoverTooltip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe("placement 'left-of' (feedback J18)", () => {
    const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);
    /** A panel at x 600–1000, a 26 px row at y 300 inside it, and a 200×40 tooltip. */
    function hover(panelLeft = 600) {
      render(
        <div data-testid="panel">
          <HoverTooltip content="tip" placement="left-of" leftOf={(t) => t.closest('[data-testid="panel"]')}><span>row</span></HoverTooltip>
        </div>,
      );
      screen.getByTestId('panel').getBoundingClientRect = () => rect(panelLeft, 0, 400, 800);
      const row = screen.getByText('row');
      row.getBoundingClientRect = () => rect(panelLeft, 300, 400, 26);
      const spy = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLDivElement) {
        return this.getAttribute('role') === 'tooltip' ? rect(0, 0, 200, 40) : rect(0, 0, 0, 0);
      });
      fireEvent.mouseEnter(row);
      spy.mockRestore();
      return screen.getByRole('tooltip');
    }

    it('puts the tooltip left of the panel, its right edge a gap before the panel, centred on the row', () => {
      const tip = hover();
      expect(tip.style.left).toBe(`${600 - 6 - 200}px`);
      expect(tip.style.top).toBe(`${300 + 13 - 20}px`);
    });

    it('with no room on the left, falls back to below the trigger', () => {
      const tip = hover(100);
      expect(tip.style.top).toBe(`${326 + 4}px`);
      expect(tip.style.left).toBe('100px');
    });
  });

  it('Esc dismisses a shown tooltip, and goes no further (WCAG 1.4.13)', () => {
    render(<HoverTooltip content="tip"><span>target</span></HoverTooltip>);
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true); // none shown: untouched
    expect(seen).toHaveBeenCalledTimes(1);
    fireEvent.mouseEnter(screen.getByText('target'));
    expect(fireEvent.keyDown(document.body, { key: 'Escape', shiftKey: true })).toBe(true);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2);
    window.removeEventListener('keydown', seen);
  });

  it('a press on the trigger hides the tooltip (as a native one), so a click then Esc is one Esc for the app', () => {
    render(<div><HoverTooltip content="tip"><span>target</span></HoverTooltip><span>elsewhere</span></div>);
    fireEvent.mouseEnter(screen.getByText('target'));
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('target'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Shown again on the next hover.
    fireEvent.mouseLeave(screen.getByText('target'));
    fireEvent.mouseEnter(screen.getByText('target'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('shows immediately by default (the app-wide no-delay rule)', () => {
    render(<HoverTooltip content="tip"><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('tip');
    fireEvent.mouseLeave(screen.getByText('target'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('with delayMs, shows only after the pointer has rested that long', () => {
    render(<HoverTooltip content="tip" delayMs={500}><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('tooltip')).toHaveTextContent('tip');
    fireEvent.mouseLeave(screen.getByText('target'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('leaving before the delay cancels the pending tooltip', () => {
    render(<HoverTooltip content="tip" delayMs={500}><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(300));
    fireEvent.mouseLeave(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('scrolling anything outside the tooltip hides it', () => {
    render(<div data-testid="scroller"><HoverTooltip content="tip"><span>target</span></HoverTooltip></div>);
    fireEvent.mouseEnter(screen.getByText('target'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.scroll(screen.getByTestId('scroller'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows on a bare mouseover: the enter React never synthesizes when the element left was removed from under the pointer', () => {
    render(<div><span>gone</span><HoverTooltip content="tip"><button type="button"><svg data-testid="icon" /></button></HoverTooltip></div>);
    // Chrome's mouseover after the hovered node was removed: no mouseout, a React-managed relatedTarget.
    fireEvent.mouseOver(screen.getByTestId('icon'), { relatedTarget: screen.getByText('gone') });
    expect(screen.getByRole('tooltip')).toHaveTextContent('tip');
    // A press still hides it, and moving within the trigger doesn't bring it back.
    fireEvent.mouseDown(screen.getByRole('button'));
    fireEvent.mouseOver(screen.getByRole('button'), { relatedTarget: screen.getByTestId('icon') });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('an interactive tooltip stays open while the pointer moves into it, and scrolls without closing', () => {
    render(<HoverTooltip content="tip" interactive><span>target</span></HoverTooltip>);
    const target = screen.getByText('target');
    fireEvent.mouseEnter(target);
    const tip = screen.getByRole('tooltip');
    fireEvent.mouseLeave(target, { relatedTarget: tip });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.scroll(tip);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(tip, { relatedTarget: document.body });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('scrolling while a delayed tooltip is still pending cancels it', () => {
    render(<div data-testid="scroller"><HoverTooltip content="tip" delayMs={500}><span>target</span></HoverTooltip></div>);
    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(300));
    fireEvent.scroll(screen.getByTestId('scroller'));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a scroll in the same frame as mouseenter (before React commits) still cancels', () => {
    // Inside one act(), nothing commits and no effect runs until the end: a listener attached
    // by an effect would miss this scroll. It must be live from the mouseenter itself.
    render(<div data-testid="scroller"><HoverTooltip content="tip" delayMs={500}><span>target</span></HoverTooltip></div>);
    act(() => {
      fireEvent.mouseEnter(screen.getByText('target'));
      fireEvent.scroll(screen.getByTestId('scroller'));
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('HoverTooltip placement="pointer"', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** jsdom does no layout: give the tooltip a size so the flip/clamp logic has something to fit. */
  const sizeTips = (width: number, height: number) => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tooltip' ? ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON() {} } as DOMRect) : real.call(this);
    });
  };

  it('appears ~12px right of the cursor, at the cursor height, and follows the pointer while shown', () => {
    render(<HoverTooltip content="tip" delayMs={500} placement="pointer"><span>target</span></HoverTooltip>);
    const target = screen.getByText('target');
    fireEvent.mouseEnter(target, { clientX: 100, clientY: 50 });
    // The rest position is wherever the pointer is when the delay ends, not where it entered.
    fireEvent.mouseMove(target, { clientX: 120, clientY: 52 });
    act(() => vi.advanceTimersByTime(500));
    const tip = screen.getByRole('tooltip');
    expect(tip.style.left).toBe('132px');
    expect(tip.style.top).toBe('52px');
    fireEvent.mouseMove(target, { clientX: 200, clientY: 60 });
    expect(tip.style.left).toBe('212px');
    expect(tip.style.top).toBe('60px');
  });

  it('flips to the left of the cursor (same gap) when it would overflow the window, and stays inside vertically', () => {
    sizeTips(300, 100);
    render(<HoverTooltip content="tip" placement="pointer"><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'), { clientX: window.innerWidth - 50, clientY: window.innerHeight - 20 });
    const tip = screen.getByRole('tooltip');
    expect(tip.style.left).toBe(`${window.innerWidth - 50 - 12 - 300}px`);
    expect(tip.style.top).toBe(`${window.innerHeight - 8 - 100}px`);
  });

  it('measures the tooltip once when it shows, not on every mouse move', () => {
    sizeTips(100, 40);
    render(<HoverTooltip content="tip" placement="pointer"><span>target</span></HoverTooltip>);
    const target = screen.getByText('target');
    fireEvent.mouseEnter(target, { clientX: 10, clientY: 10 });
    const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    measure.mockClear();
    for (let x = 20; x < 200; x += 10) fireEvent.mouseMove(target, { clientX: x, clientY: 10 });
    expect(measure).not.toHaveBeenCalled();
    // Still placed with the cached size: flipped left near the right edge.
    fireEvent.mouseMove(target, { clientX: window.innerWidth - 20, clientY: 10 });
    expect(screen.getByRole('tooltip').style.left).toBe(`${window.innerWidth - 20 - 12 - 100}px`);
  });

  it('marks a tooltip whose content is cut at its max height (data-clipped), for a visible cue', () => {
    const sh = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    render(<HoverTooltip content="long" placement="pointer"><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'), { clientX: 10, clientY: 10 });
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-clipped');
    fireEvent.mouseLeave(screen.getByText('target'));
    sh.mockReturnValue(100);
    ch.mockReturnValue(100);
    fireEvent.mouseEnter(screen.getByText('target'), { clientX: 10, clientY: 10 });
    expect(screen.getByRole('tooltip')).not.toHaveAttribute('data-clipped');
  });

  it('tooltip.css makes a non-interactive tooltip ignore the pointer entirely', () => {
    // vitest doesn't load CSS (see graph.css.test.ts): pin the rule in the source instead.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tooltip.css'), 'utf8');
    expect(css.match(/\.hover-tooltip\s*\{([^}]*)\}/)?.[1]).toMatch(/pointer-events:\s*none/);
  });

  it('is never interactive (even if asked to be): moving onto it counts as leaving the trigger', () => {
    render(<HoverTooltip content="tip" placement="pointer" interactive><span>target</span></HoverTooltip>);
    const target = screen.getByText('target');
    fireEvent.mouseEnter(target, { clientX: 10, clientY: 10 });
    const tip = screen.getByRole('tooltip');
    expect(tip).not.toHaveClass('interactive');
    fireEvent.mouseLeave(target, { relatedTarget: tip });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('HoverTooltip with async content', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function deferred() {
    let resolve!: (v: string) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('loads after the delay, shows "Loading…" only if loading takes over ~100 ms, then the content', async () => {
    const d = deferred();
    const load = vi.fn(() => d.promise);
    render(<HoverTooltip content={load} delayMs={500}><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(499));
    expect(load).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(load).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(99));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Loading…');
    await act(async () => d.resolve('the message'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('the message');
  });

  it('a fast load never flashes "Loading…"', async () => {
    const d = deferred();
    render(<HoverTooltip content={() => d.promise} delayMs={500}><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(530));
    expect(screen.queryByRole('tooltip')).toBeNull();
    await act(async () => d.resolve('quick'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('quick');
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('tooltip')).toHaveTextContent('quick');
  });

  it('a synchronous result (e.g. cached) shows right at the delay', () => {
    render(<HoverTooltip content={() => 'cached'} delayMs={500}><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('tooltip')).toHaveTextContent('cached');
  });

  it('leaving before the load resolves shows nothing', async () => {
    const d = deferred();
    render(<HoverTooltip content={() => d.promise} delayMs={500}><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(520));
    fireEvent.mouseLeave(screen.getByText('target'));
    await act(async () => d.resolve('late'));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('scrolling before the load resolves shows nothing (and hides "Loading…")', async () => {
    const d = deferred();
    render(<div data-testid="scroller"><HoverTooltip content={() => d.promise} delayMs={500}><span>target</span></HoverTooltip></div>);
    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(650));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Loading…');
    fireEvent.scroll(screen.getByTestId('scroller'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    await act(async () => d.resolve('late'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a failed load closes the tooltip', async () => {
    const d = deferred();
    render(<HoverTooltip content={() => d.promise} delayMs={500}><span>target</span></HoverTooltip>);
    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => vi.advanceTimersByTime(700));
    await act(async () => d.reject(new Error('boom')));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('placement near the window edge (K52)', () => {
  it('placeBelow shifts a wide tooltip left instead of shrinking it, and flips above at the bottom', async () => {
    const { placeBelow } = await import('./HoverTooltip');
    const size = { width: 300, height: 40 };
    const { left, top } = placeBelow({ left: window.innerWidth - 20, top: 10, bottom: 34 }, size);
    expect(left).toBe(window.innerWidth - 8 - 300);
    expect(top).toBe(38);
    const flipped = placeBelow({ left: 100, top: window.innerHeight - 30, bottom: window.innerHeight - 6 }, size);
    expect(flipped.top).toBe(window.innerHeight - 30 - 4 - 40);
  });

  it('measures the tooltip parked at the origin, so near-edge anchors do not squeeze it', async () => {
    const { measureNatural } = await import('./HoverTooltip');
    const el = document.createElement('div');
    el.style.left = '990px';
    let leftWhenMeasured = '';
    el.getBoundingClientRect = () => { leftWhenMeasured = el.style.left; return new DOMRect(0, 0, 250, 30); };
    expect(measureNatural(el)).toEqual({ width: 250, height: 30 });
    expect(leftWhenMeasured).toBe('0px');
  });

  it('the css never breaks inside words and caps the width at ~320px', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tooltip.css'), 'utf8');
    expect(css).toMatch(/max-width:\s*min\(320px/);
    expect(css).toMatch(/overflow-wrap:\s*break-word/);
    expect(css).not.toMatch(/overflow-wrap:\s*anywhere/);
  });
});
