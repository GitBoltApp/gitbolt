import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { useImageBackground } from './background';
import { ImageDiff } from './ImageDiff';
import { ZOOM_STEPS } from './zoom';

/** The zoom slider's value for a step. */
const stepOf = (s: (typeof ZOOM_STEPS)[number]) => String(ZOOM_STEPS.indexOf(s));
import { blobFor, useImageSources } from './sources';

/** jsdom never decodes images. This stand-in "decodes" `blob:WxH` URLs and fails on anything else. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(url: string) {
    const m = /(\d+)x(\d+)$/.exec(url);
    if (url.endsWith(':pending')) return; // still decoding
    queueMicrotask(() => {
      if (m) {
        this.naturalWidth = Number(m[1]);
        this.naturalHeight = Number(m[2]);
        this.onload?.();
      } else this.onerror?.();
    });
  }
}

const wheel = (el: Element, deltaY: number, ctrlKey = true) => {
  const e = new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(e); });
  return e;
};

beforeEach(() => {
  localStorage.clear();
  useImageBackground.setState({ background: 'checker' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ImageDiff', () => {
  it('an added or deleted image shows only its own side, labelled, with no compare modes (H25)', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { unmount } = render(<ImageDiff old={null} new={{ url: 'blob:760x119', size: 70 }} single="added" />);
    await waitFor(() => expect(screen.getByTestId('image-meta')).toHaveTextContent(/^760×119 · 70 B \(added\)$/));
    expect(screen.queryByRole('group', { name: 'Image mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Swipe' })).toBeNull();
    unmount();
    const deleted = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={null} single="deleted" />);
    await waitFor(() => expect(screen.getByTestId('image-meta')).toHaveTextContent(/^4×4 · 60 B \(deleted\)$/));
    deleted.unmount();
    // A changed image: both sides, and every mode.
    const changed = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-meta')).toHaveTextContent(/^4×4 → 6×4 · 60 B → 70 B$/));
    expect(screen.getByRole('button', { name: 'Swipe' })).toBeEnabled();
    changed.unmount();
  });

  it('double-clicking the swipe handle puts it back at 50% (K73)', () => {
    render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));
    const s = screen.getByRole('slider', { name: 'Swipe position' });
    fireEvent.keyDown(s, { key: 'ArrowLeft' });
    expect(s).toHaveAttribute('aria-valuenow', '45');
    fireEvent.doubleClick(s);
    expect(s).toHaveAttribute('aria-valuenow', '50');
  });

  it('offers every mode for a changed one', () => {
    render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} source={<div>svg source</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));
    expect(screen.getByRole('slider', { name: 'Swipe position' })).toHaveAttribute('aria-valuenow', '50');
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Swipe position' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('slider', { name: 'Swipe position' })).toHaveAttribute('aria-valuenow', '45');
    fireEvent.click(screen.getByRole('button', { name: 'Onion skin' }));
    expect(screen.getByRole('slider', { name: 'Opacity' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: stepOf(4) } });
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByText('svg source')).toBeInTheDocument();
  });

  it('keeps zoom and pan when the mode changes', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { container } = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: stepOf(4) } });
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
    expect(container.querySelector<HTMLImageElement>('img.image-layer')!.style.transform).toContain('scale(4)');
    fireEvent.click(screen.getByRole('button', { name: 'Side-by-side' }));
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
  });

  it("opens at 100%; the slider's minimum is the ladder's own first rung, not Fit (H23, K12)", async () => {
    vi.stubGlobal('Image', FakeImage);
    render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('100%');
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '0' } });
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('10%');
  });

  it('Fit is a dedicated button (K12), the zoom % is editable (K13), and the slider double-click resets to 100% (K14)', async () => {
    vi.stubGlobal('Image', FakeImage);
    render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: stepOf(4) } });
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
    // K13: click to edit, Enter applies (clamped to the zoom range).
    fireEvent.click(screen.getByTestId('zoom-label'));
    const input = screen.getByTestId('zoom-input');
    expect(input).toHaveValue('400');
    fireEvent.change(input, { target: { value: '250' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByTestId('zoom-input')).toBeNull();
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('250%');
    // Clamped to the zoom range (1000% max).
    fireEvent.click(screen.getByTestId('zoom-label'));
    fireEvent.change(screen.getByTestId('zoom-input'), { target: { value: '99999' } });
    fireEvent.keyDown(screen.getByTestId('zoom-input'), { key: 'Enter' });
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('1000%');
    // Esc cancels, discarding the edit, and doesn't close the file.
    fireEvent.click(screen.getByTestId('zoom-label'));
    fireEvent.change(screen.getByTestId('zoom-input'), { target: { value: '12' } });
    fireEvent.keyDown(screen.getByTestId('zoom-input'), { key: 'Escape' });
    expect(screen.queryByTestId('zoom-input')).toBeNull();
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('1000%');
    // Blur applies.
    fireEvent.click(screen.getByTestId('zoom-label'));
    fireEvent.change(screen.getByTestId('zoom-input'), { target: { value: '50' } });
    fireEvent.blur(screen.getByTestId('zoom-input'));
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('50%');
    // K14: double-click the slider resets to 100%.
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'Zoom' }));
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('100%');
    // K12: Fit is a button, always present, distinct from the slider/value. jsdom has no real
    // layout (the box measures 0), so `fitScale` degrades to 1×; the real percentage is an e2e
    // concern (image.spec.ts) — this just proves the wiring runs without throwing.
    expect(screen.getByRole('button', { name: 'Fit' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('100%');
  });

  it('Ctrl+wheel zooms along the fine ladder, is prevented, accumulates small deltas and ignores deltaY 0 (H24)', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { container, unmount } = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    const stage = container.querySelector('.image-stage')!;
    // It opens at 100%: one notch in is the next rung, 110%.
    expect(wheel(stage, 0).defaultPrevented).toBe(true);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('100%');
    expect(wheel(stage, -100, false).defaultPrevented).toBe(false);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('100%');
    expect(wheel(stage, -100).defaultPrevented).toBe(true);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('110%');
    // A trackpad pinch sends many small deltas: 100 px in total is two steps, not ten.
    for (let i = 0; i < 10; i++) wheel(stage, -10);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('150%');
    wheel(stage, 100);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('125%');
    unmount();
    // The native listener is gone with the component.
    expect(wheel(stage, -100).defaultPrevented).toBe(false);
  });

  it('the swipe handle and the onion opacity start at 50% each time their mode is entered, and the handle stays keyboard-operable (H28, H29)', () => {
    render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} />);
    const handle = () => screen.getByRole('slider', { name: 'Swipe position' });
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));
    expect(handle()).toHaveAttribute('aria-valuenow', '50');
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(handle()).toHaveAttribute('aria-valuenow', '55');
    fireEvent.click(screen.getByRole('button', { name: 'Onion skin' }));
    expect(screen.getByRole('slider', { name: 'Opacity' })).toHaveValue('50');
    fireEvent.change(screen.getByRole('slider', { name: 'Opacity' }), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));
    expect(handle()).toHaveAttribute('aria-valuenow', '50');
    fireEvent.click(screen.getByRole('button', { name: 'Onion skin' }));
    expect(screen.getByRole('slider', { name: 'Opacity' })).toHaveValue('50');
  });

  it('a mouse-down anywhere on the image in Swipe mode jumps the handle to the pointer and keeps dragging it (K8)', () => {
    const { container } = render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));
    const handle = () => screen.getByRole('slider', { name: 'Swipe position' });
    expect(handle()).toHaveAttribute('aria-valuenow', '50');
    const viewport = container.querySelector('.image-viewport')!;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100, top: 0, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    // A plain click (no capture, jsdom doesn't implement setPointerCapture's real semantics) jumps it.
    fireEvent.pointerDown(viewport, { button: 0, clientX: 80, pointerId: 1 });
    expect(handle()).toHaveAttribute('aria-valuenow', '80');
    // The drag continues: a move with the button held keeps following the pointer.
    fireEvent.pointerMove(viewport, { buttons: 1, clientX: 20, pointerId: 1 });
    expect(handle()).toHaveAttribute('aria-valuenow', '20');
    // Released (or the button let go elsewhere): further moves don't.
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    fireEvent.pointerMove(viewport, { buttons: 1, clientX: 90, pointerId: 1 });
    expect(handle()).toHaveAttribute('aria-valuenow', '20');
  });

  it('shows subtle, non-interactive Old/New labels in side-by-side, swipe and onion skin, never for a single added/deleted image (K9)', () => {
    vi.stubGlobal('Image', FakeImage);
    const { container, rerender } = render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} />);
    // pointer-events: none is asserted from the stylesheet itself (image.css.test.ts): jsdom
    // doesn't apply an imported CSS file's rules, so `getComputedStyle` here wouldn't see it.
    const labels = () => [...container.querySelectorAll('.image-label')];
    expect(labels().map((l) => l.textContent)).toEqual(['Old', 'New']);
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));
    expect(labels().map((l) => l.textContent)).toEqual(['Old', 'New']);
    fireEvent.click(screen.getByRole('button', { name: 'Onion skin' }));
    expect(labels().map((l) => l.textContent)).toEqual(['Old', 'New']);
    fireEvent.click(screen.getByRole('button', { name: 'Difference' }));
    // No Old/New chips in Difference (K9 doesn't list it) — only K10's Amplify label, which shares
    // the same subtle-chip class.
    expect(labels().map((l) => l.textContent)).toEqual(['Amplify']);
    // A single added/deleted image (H25) never gets a label: nothing to compare against.
    rerender(<ImageDiff old={null} new={{ url: 'blob:new', size: 70 }} single="added" />);
    expect(container.querySelectorAll('.image-label')).toHaveLength(0);
  });

  it('side-by-side gets a divider between the two halves only when both images exist (K21)', () => {
    vi.stubGlobal('Image', FakeImage);
    const { container, rerender } = render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} />);
    expect(container.querySelectorAll('.side-divider')).toHaveLength(1);
    // A single added/deleted image (H25) has only one half: no divider to draw.
    rerender(<ImageDiff old={null} new={{ url: 'blob:new', size: 70 }} single="added" />);
    expect(container.querySelectorAll('.side-divider')).toHaveLength(0);
  });

  /** Waits a frame — long enough for a `requestAnimationFrame`-coalesced repaint to run. */
  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  it("Difference mode's Amplify slider is the TRUE multiplier, defaults to 4× (the old fixed brighten's look), ranges 1×–16×, and repaints without reloading the images (K10)", async () => {
    vi.stubGlobal('Image', FakeImage);
    const draw = vi.spyOn(await import('./difference'), 'drawDifference');
    render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    fireEvent.click(screen.getByRole('button', { name: 'Difference' }));
    const amplify = () => screen.getByRole('slider', { name: 'Amplify' });
    await waitFor(() => expect(amplify()).toHaveValue('4'));
    expect(amplify()).toHaveAttribute('min', '1');
    expect(amplify()).toHaveAttribute('max', '16');
    expect(screen.getByTestId('amplify-value')).toHaveTextContent('4×');
    // The initial draw (on entering Difference) already used the true multiplier, 4, not 4*1.
    expect(draw.mock.calls.at(-1)![5]).toBe(4);
    const calls = draw.mock.calls.length;
    fireEvent.change(amplify(), { target: { value: '8' } });
    expect(screen.getByTestId('amplify-value')).toHaveTextContent('8×');
    // Coalesced to the next animation frame (fix round 1): not drawn synchronously on `change`.
    expect(draw.mock.calls.length).toBe(calls);
    await nextFrame();
    expect(draw.mock.calls.length).toBe(calls + 1);
    expect(draw.mock.calls.at(-1)![5]).toBe(8);
  });

  it('several rapid Amplify changes coalesce into a single repaint per animation frame, using the latest value (fix round 1)', async () => {
    vi.stubGlobal('Image', FakeImage);
    const draw = vi.spyOn(await import('./difference'), 'drawDifference');
    render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    fireEvent.click(screen.getByRole('button', { name: 'Difference' }));
    const amplify = () => screen.getByRole('slider', { name: 'Amplify' });
    await waitFor(() => expect(amplify()).toHaveValue('4'));
    const calls = draw.mock.calls.length;
    // Several rapid ticks, as a drag would fire, all before the next frame paints.
    for (const v of [5, 9, 13, 16]) fireEvent.change(amplify(), { target: { value: String(v) } });
    expect(draw.mock.calls.length).toBe(calls); // nothing drawn synchronously
    await nextFrame();
    // Exactly one repaint for the whole burst, at the last value.
    expect(draw.mock.calls.length).toBe(calls + 1);
    expect(draw.mock.calls.at(-1)![5]).toBe(16);
  });

  it('background toggles at the far right: checkerboard by default, black, white, grey; remembered (H30)', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { container } = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    const group = screen.getByRole('group', { name: 'Image background' });
    expect(group.parentElement!.lastElementChild).toBe(group);
    const names = ['Checkerboard background', 'Black background', 'White background', 'Grey background'];
    expect([...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(names);
    expect(screen.getByRole('button', { name: 'Checkerboard background' })).toHaveAttribute('aria-pressed', 'true');
    // The pick is behind the image only (J11): the frames at its bounds, not the viewports.
    const viewports = () => [...container.querySelectorAll('.image-frame')].map((v) => v.className);
    expect(viewports()).toHaveLength(2);
    expect(viewports().every((c) => c.includes('bg-checker'))).toBe(true);
    for (const name of names) {
      const b = screen.getByRole('button', { name });
      expect(b).toHaveTextContent(/^$/);
      expect(b).not.toHaveAttribute('title');
      fireEvent.mouseEnter(b);
      expect(screen.getByRole('tooltip')).toHaveTextContent(name);
      fireEvent.mouseLeave(b);
    }
    fireEvent.click(screen.getByRole('button', { name: 'White background' }));
    expect(screen.getByRole('button', { name: 'White background' })).toHaveAttribute('aria-pressed', 'true');
    expect(viewports().every((c) => c.includes('bg-white'))).toBe(true);
    expect(localStorage.getItem('gitbolt.imageBackground.v1')).toBe('white');
    // The difference view keeps its black canvas.
    fireEvent.click(screen.getByRole('button', { name: 'Difference' }));
    expect(viewports()).toEqual([expect.stringContaining('bg-black')]);
  });

  it("frames each image's own bounds: the background inside, a border, the viewport neutral outside (J11)", async () => {
    vi.stubGlobal('Image', FakeImage);
    useImageBackground.setState({ background: 'white' });
    const { container } = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    const frames = () => [...container.querySelectorAll<HTMLElement>('.image-frame')];
    const size = (f: HTMLElement) => [f.style.width, f.style.height];
    // No viewport paints the pick: outside the image is the panel's grey.
    expect([...container.querySelectorAll('.image-viewport')].some((v) => /\bbg-/.test(v.className))).toBe(false);
    // Side by side: each viewport frames its own image, at its size on screen, where the layer is.
    expect(frames().map(size)).toEqual([['4px', '4px'], ['6px', '4px']]);
    expect(frames().every((f) => f.classList.contains('bg-white'))).toBe(true);
    const layers = [...container.querySelectorAll<HTMLElement>('img.image-layer')];
    expect(frames().map((f) => f.style.transform)).toEqual(layers.map((l) => expect.stringContaining(l.style.transform.replace(/ scale\(.*\)$/, ''))));
    // Zoomed, the frame follows.
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: stepOf(4) } });
    expect(frames().map(size)).toEqual([['16px', '16px'], ['24px', '16px']]);
    // Swipe and onion skin overlay both: one frame, around both.
    for (const mode of ['Swipe', 'Onion skin']) {
      fireEvent.click(screen.getByRole('button', { name: mode }));
      expect(frames().map(size)).toEqual([['24px', '16px']]);
    }
    // Difference keeps its own (black) rendering, framed too.
    fireEvent.click(screen.getByRole('button', { name: 'Difference' }));
    expect(frames().map(size)).toEqual([['24px', '16px']]);
    expect(frames()[0]).toHaveClass('bg-black');
    expect(frames()[0].nextElementSibling).toBe(screen.getByTestId('image-difference'));
  });

  it("the checkerboard toggle's icon is our own SVG, a 3×3 board of big squares filling its box (J12)", () => {
    render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} />);
    const svg = screen.getByRole('button', { name: 'Checkerboard background' }).querySelector('svg')!;
    expect(svg).not.toBeNull();
    const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const cells = [...svg.querySelectorAll('rect.checker-light')].map((r) => ({ x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')), w: Number(r.getAttribute('width')) }));
    // Five light cells of a third of the box each: the corners and the centre.
    expect(cells).toHaveLength(5);
    expect(cells.every((c) => c.w === w / 3)).toBe(true);
    expect(new Set(cells.map((c) => `${(c.x / (w / 3))},${(c.y / (h / 3))}`))).toEqual(new Set(['0,0', '2,0', '1,1', '0,2', '2,2']));
    // The dark cells are the board behind them, filling the box.
    const board = svg.querySelector('rect.checker-dark')!;
    expect([board.getAttribute('width'), board.getAttribute('height')]).toEqual([String(w), String(h)]);
  });

  it('keeps the images hidden until every side is decoded and placed: never a frame at the top left (J13)', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { container } = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    const layers = () => [...container.querySelectorAll<HTMLElement>('img.image-layer')];
    // Not decoded yet (FakeImage decodes in a microtask): no size, so no view to place them at.
    expect(layers()).toHaveLength(2);
    expect(layers().map((l) => l.style.visibility)).toEqual(['hidden', 'hidden']);
    expect(container.querySelectorAll('.image-frame')).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    expect(layers().map((l) => l.style.visibility)).toEqual(['', '']);
    // One side decoded, the other not: both wait, since the second one's size moves the view.
    const partial = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:pending', size: 70 }} />);
    await waitFor(() => expect(within(partial.container).getByTestId('image-dims')).toHaveTextContent(/^4×4 → …$/));
    expect([...partial.container.querySelectorAll<HTMLElement>('img.image-layer')].map((l) => l.style.visibility)).toEqual(['hidden', 'hidden']);
    expect(partial.container.querySelectorAll('.image-frame')).toHaveLength(0);
    // A side that fails to decode doesn't hold the other back.
    const failed = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:broken', size: 70 }} />);
    await waitFor(() => expect(within(failed.container).getByTestId('image-dims')).toHaveTextContent(/^4×4 → \?$/));
    expect([...failed.container.querySelectorAll<HTMLElement>('img.image-layer')].map((l) => l.style.visibility)).toEqual(['']);
  });

  it('hidden with the kept diff panel and shown again, it reports its Source state again (J16, H26)', () => {
    const onSourceChange = vi.fn();
    const ui = (mode: 'visible' | 'hidden') => <Activity mode={mode}><ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} source={<div>svg source</div>} onSourceChange={onSourceChange} /></Activity>;
    const view = render(ui('visible'));
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(onSourceChange).toHaveBeenLastCalledWith(true);
    view.rerender(ui('hidden'));
    expect(onSourceChange).toHaveBeenLastCalledWith(false);
    view.rerender(ui('visible'));
    expect(onSourceChange).toHaveBeenLastCalledWith(true);
  });

  it('shows a message in place of an image that fails to decode', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { container } = render(<ImageDiff old={{ url: 'blob:broken', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    expect(await screen.findByText("Image couldn't be decoded")).toBeInTheDocument();
    expect(screen.getByTestId('image-dims')).toHaveTextContent('? → 6×4');
    expect(container.querySelectorAll('img.image-layer')).toHaveLength(1);
  });

  it('suppresses the native context menu on the image stage', () => {
    const { container } = render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} />);
    expect(fireEvent.contextMenu(container.querySelector('.image-stage img')!)).toBe(false);
  });

  it('builds blobs from base64 bytes or SVG text', async () => {
    const png = blobFor({ size: 3, binary: true, encoding: '', eol: 'none', text: null, base64: btoa('\x89PN') }, 'image/png')!;
    expect([png.type, png.size]).toEqual(['image/png', 3]);
    expect([...new Uint8Array(await png.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e]);
    const svg = blobFor({ size: 5, binary: false, encoding: 'UTF-8', eol: 'none', text: '<svg/>', base64: null }, 'image/svg+xml')!;
    expect(await svg.text()).toBe('<svg/>');
    expect(blobFor(null, 'image/png')).toBeNull();
  });

  it('revokes its object URLs when the contents change and on unmount', () => {
    let n = 0;
    const create = vi.fn(() => `blob:u${++n}`);
    const revoke = vi.fn();
    // jsdom has no object URLs, so there is nothing to spy on: swap them in and restore.
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    onTestFinished(() => {
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    });
    const side = (text: string) => ({ size: text.length, binary: false, encoding: 'UTF-8', eol: 'none' as const, text, base64: null });
    const contents = (a: string, b: string): DiffContentsPayload => ({ old: side(a), new: side(b), tooLarge: false, eolOnly: false, image: false });
    const { result, rerender, unmount } = renderHook(({ c }) => useImageSources(c, 'icon.svg'), { initialProps: { c: contents('<svg/>', '<svg />') } });
    expect(result.current).toEqual({ old: { url: 'blob:u1', size: 6, intrinsic: null }, new: { url: 'blob:u2', size: 7, intrinsic: null } });
    expect(revoke).not.toHaveBeenCalled();
    rerender({ c: contents('<svg/>', '<svg  />') });
    expect(revoke.mock.calls.map((c) => c[0])).toEqual(['blob:u1', 'blob:u2']);
    expect(result.current?.new?.url).toBe('blob:u4');
    unmount();
    expect(revoke.mock.calls.map((c) => c[0])).toEqual(['blob:u1', 'blob:u2', 'blob:u3', 'blob:u4']);
  });
});
