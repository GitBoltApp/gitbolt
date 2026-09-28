import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverTooltip } from './HoverTooltip';

describe('HoverTooltip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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
