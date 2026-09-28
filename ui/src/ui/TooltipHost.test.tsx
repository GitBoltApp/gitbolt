import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipHost } from './TooltipHost';
import { hideTooltip, showTooltip } from './tooltipStore';

describe('TooltipHost (the shared imperative tooltip, plan 1C Task 10)', () => {
  afterEach(() => { act(() => hideTooltip()); vi.useRealTimers(); });

  it('shows immediately by default and hides on hideTooltip', () => {
    render(<><button type="button">SHA</button><TooltipHost /></>);
    act(() => showTooltip(screen.getByRole('button'), 'Copy the full SHA'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Copy the full SHA');
    expect(screen.getByRole('tooltip')).toHaveClass('hover-tooltip');
    act(() => hideTooltip());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('honours an explicit delay; hiding first cancels it', () => {
    vi.useFakeTimers();
    render(<><span>msg</span><TooltipHost /></>);
    act(() => showTooltip(screen.getByText('msg'), 'Full message', 500));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Full message');
    act(() => hideTooltip());
    act(() => showTooltip(screen.getByText('msg'), 'Again', 500));
    act(() => hideTooltip());
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a press or a scroll anywhere hides it', () => {
    render(<><button type="button">x</button><TooltipHost /></>);
    act(() => showTooltip(screen.getByRole('button'), 'tip'));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => showTooltip(screen.getByRole('button'), 'tip'));
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it("placement 'right' sits beside the target instead of below it", () => {
    render(<><button type="button">row</button><TooltipHost /></>);
    const el = screen.getByRole('button');
    el.getBoundingClientRect = () => ({ left: 100, right: 300, top: 50, bottom: 76, width: 200, height: 26, x: 100, y: 50, toJSON() {} });
    act(() => showTooltip(el, 'beside', 0, 'right'));
    const tip = screen.getByRole('tooltip');
    expect(tip.style.top).toBe('50px');
    expect(tip.style.left).toBe('304px');
    // 'left' (a submenu opened leftwards): left of the target, flipped right when it can't fit.
    act(() => showTooltip(el, 'beside', 0, 'left'));
    expect(screen.getByRole('tooltip').style.left).toBe('96px');
    el.getBoundingClientRect = () => ({ left: 2, right: 300, top: 50, bottom: 76, width: 298, height: 26, x: 2, y: 50, toJSON() {} });
    act(() => showTooltip(el, 'flipped', 0, 'left'));
    expect(screen.getByRole('tooltip').style.left).toBe('304px');
  });
});
