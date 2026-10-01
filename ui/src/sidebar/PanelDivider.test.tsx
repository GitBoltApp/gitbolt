import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_PANEL_H } from './layout';
import { PanelDivider } from './PanelDivider';

afterEach(() => vi.unstubAllGlobals());

function setup(upperH = 200, lowerH = 200) {
  const upper = document.createElement('div');
  const lower = document.createElement('div');
  const onCommit = vi.fn();
  render(<PanelDivider label="Resize" upperH={upperH} lowerH={lowerH} getEls={() => [upper, lower]} onCommit={onCommit} onReset={() => {}} />);
  return { sep: screen.getByRole('separator', { name: 'Resize' }), upper, lower, onCommit };
}

describe('PanelDivider', () => {
  it('exposes its range', () => {
    const { sep } = setup();
    expect(sep).toHaveAttribute('aria-valuemin', String(MIN_PANEL_H));
    expect(sep).toHaveAttribute('aria-valuemax', String(400 - MIN_PANEL_H));
  });

  it('coalesces pointermoves into one rAF write and commits once, on release', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { sep, upper, lower, onCommit } = setup();
    fireEvent.pointerDown(sep, { clientY: 100, button: 0 });
    for (const y of [110, 120, 130, 140]) fireEvent.pointerMove(sep, { clientY: y });
    expect(frames).toHaveLength(1);
    expect(upper.style.height).toBe('');
    frames[0](0);
    expect(upper.style.height).toBe('240px');
    expect(lower.style.height).toBe('160px');
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(sep);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(240, 160);
  });

  it('clamps at the minimum on both sides', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { sep, onCommit } = setup();
    fireEvent.pointerDown(sep, { clientY: 500, button: 0 });
    fireEvent.pointerMove(sep, { clientY: -5000 });
    fireEvent.pointerUp(sep);
    expect(onCommit).toHaveBeenLastCalledWith(MIN_PANEL_H, 400 - MIN_PANEL_H);
    fireEvent.pointerDown(sep, { clientY: 0, button: 0 });
    fireEvent.pointerMove(sep, { clientY: 5000 });
    fireEvent.pointerUp(sep);
    expect(onCommit).toHaveBeenLastCalledWith(400 - MIN_PANEL_H, MIN_PANEL_H);
  });

  it('a release without movement commits nothing', () => {
    const { sep, onCommit } = setup();
    fireEvent.pointerDown(sep, { clientY: 5, button: 0 });
    fireEvent.pointerUp(sep);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('PanelDivider double-click (K73)', () => {
  it('asks to reset the layout, without committing a drag', () => {
    const onReset = vi.fn();
    const onCommit = vi.fn();
    render(<PanelDivider label="Resize" upperH={300} lowerH={100} getEls={() => [null, null]} onCommit={onCommit} onReset={onReset} />);
    const sep = screen.getByRole('separator', { name: 'Resize' });
    fireEvent.pointerDown(sep, { clientY: 100, button: 0 });
    fireEvent.pointerUp(sep, { clientY: 100 });
    fireEvent.doubleClick(sep);
    expect(onReset).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
