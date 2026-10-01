import { act, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SplitResizer } from './SplitResizer';

/** Waits a frame: the live ratio is written to `flexBasis` in a `requestAnimationFrame`,
 * coalescing however many `pointermove` events land within it (K26). */
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

describe('SplitResizer', () => {
  it('coalesces a burst of pointermoves into one rAF-scheduled flexBasis write, and defers onChange/onCommit to pointerup', async () => {
    const targetRef = createRef<HTMLDivElement>();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(
      <>
        <div ref={targetRef} style={{ flexBasis: '25%' }} />
        <SplitResizer ratio={0.25} bounds={[0.1, 0.75]} height={1000} onChange={onChange} onCommit={onCommit} targetRef={targetRef} />
      </>,
    );
    const sep = document.querySelector('[role="separator"]')!;
    fireEvent.pointerDown(sep, { clientY: 250, pointerId: 1, button: 0 });
    // Three moves land before the next frame: only one rAF is scheduled for them.
    fireEvent.pointerMove(sep, { clientY: 300, pointerId: 1 }); // ratio 0.30
    fireEvent.pointerMove(sep, { clientY: 350, pointerId: 1 }); // ratio 0.35
    fireEvent.pointerMove(sep, { clientY: 400, pointerId: 1 }); // ratio 0.40 (the one that should land)
    expect(raf).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(targetRef.current).toHaveStyle({ flexBasis: '25%' });
    await nextFrame();
    // Only the latest move's value lands — not the intermediate 30%/35%.
    expect(targetRef.current).toHaveStyle({ flexBasis: '40%' });
    expect(onChange).not.toHaveBeenCalled(); // still not committed to React
    expect(onCommit).not.toHaveBeenCalled(); // and not persisted
    fireEvent.pointerUp(sep, { clientY: 400, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(0.4);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.4);
    raf.mockRestore();
  });

  it('a move after pointerup is a no-op: the gesture already ended', async () => {
    const targetRef = createRef<HTMLDivElement>();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <>
        <div ref={targetRef} style={{ flexBasis: '25%' }} />
        <SplitResizer ratio={0.25} bounds={[0.1, 0.75]} height={1000} onChange={onChange} onCommit={onCommit} targetRef={targetRef} />
      </>,
    );
    const sep = document.querySelector('[role="separator"]')!;
    fireEvent.pointerDown(sep, { clientY: 250, pointerId: 1, button: 0 });
    fireEvent.pointerUp(sep, { clientY: 250, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientY: 400, pointerId: 1 });
    await nextFrame();
    expect(targetRef.current).toHaveStyle({ flexBasis: '25%' });
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('SplitResizer double-click (K73)', () => {
  it('resets to the default ratio and persists it', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<SplitResizer ratio={0.6} bounds={[0.1, 0.75]} height={1000} onChange={onChange} onCommit={onCommit} targetRef={createRef<HTMLDivElement>()} />);
    fireEvent.doubleClick(document.querySelector('[role="separator"]')!);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(0.25);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.25);
  });

  it('uses the given default (the WIP split resets to 50%)', () => {
    const onCommit = vi.fn();
    render(<SplitResizer ratio={0.7} bounds={[0.1, 0.9]} height={1000} defaultRatio={0.5} onChange={() => {}} onCommit={onCommit} targetRef={createRef<HTMLDivElement>()} />);
    fireEvent.doubleClick(document.querySelector('[role="separator"]')!);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.5);
  });
});
