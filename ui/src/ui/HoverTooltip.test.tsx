import { act, fireEvent, render, screen } from '@testing-library/react';
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
