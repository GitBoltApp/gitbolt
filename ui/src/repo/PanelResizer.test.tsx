import { act, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PanelResizer } from './PanelResizer';

/** Waits a frame: the live width is written in a `requestAnimationFrame`, coalescing however
 * many `pointermove` events land within it (K26). */
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

describe('PanelResizer', () => {
  it('coalesces a burst of pointermoves into one rAF-scheduled DOM write, and defers onChange to pointerup', async () => {
    const panelRef = createRef<HTMLDivElement>();
    const onChange = vi.fn();
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(
      <>
        <PanelResizer width={400} min={100} max={800} onChange={onChange} panelRef={panelRef} />
        <div ref={panelRef} style={{ width: 400 }} />
      </>,
    );
    const sep = document.querySelector('[role="separator"]')!;
    fireEvent.pointerDown(sep, { clientX: 800, pointerId: 1, button: 0 });
    // Three moves land before the next frame: only one rAF is scheduled for them.
    fireEvent.pointerMove(sep, { clientX: 780, pointerId: 1 }); // width 420
    fireEvent.pointerMove(sep, { clientX: 750, pointerId: 1 }); // width 450
    fireEvent.pointerMove(sep, { clientX: 700, pointerId: 1 }); // width 500 (the one that should land)
    expect(raf).toHaveBeenCalledTimes(1);
    // Nothing committed to React (or the DOM) until the frame fires.
    expect(onChange).not.toHaveBeenCalled();
    expect(panelRef.current).toHaveStyle({ width: '400px' });
    await nextFrame();
    // Only the latest move's value lands — not the intermediate 420/450.
    expect(panelRef.current).toHaveStyle({ width: '500px' });
    expect(onChange).not.toHaveBeenCalled(); // still not committed to React
    fireEvent.pointerUp(sep, { clientX: 700, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
    raf.mockRestore();
  });

  it('a move after pointerup is a no-op: the gesture already ended', async () => {
    const panelRef = createRef<HTMLDivElement>();
    const onChange = vi.fn();
    render(
      <>
        <PanelResizer width={400} min={100} max={800} onChange={onChange} panelRef={panelRef} />
        <div ref={panelRef} style={{ width: 400 }} />
      </>,
    );
    const sep = document.querySelector('[role="separator"]')!;
    fireEvent.pointerDown(sep, { clientX: 800, pointerId: 1, button: 0 });
    fireEvent.pointerUp(sep, { clientX: 800, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 700, pointerId: 1 });
    await nextFrame();
    expect(panelRef.current).toHaveStyle({ width: '400px' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clamps the live value to min/max while dragging', async () => {
    const panelRef = createRef<HTMLDivElement>();
    const onChange = vi.fn();
    render(
      <>
        <PanelResizer width={400} min={100} max={800} onChange={onChange} panelRef={panelRef} />
        <div ref={panelRef} style={{ width: 400 }} />
      </>,
    );
    const sep = document.querySelector('[role="separator"]')!;
    fireEvent.pointerDown(sep, { clientX: 800, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep, { clientX: -10_000, pointerId: 1 }); // far left: widens past max
    await nextFrame();
    expect(panelRef.current).toHaveStyle({ width: '800px' });
    fireEvent.pointerUp(sep, { clientX: -10_000, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(800);
  });
});
