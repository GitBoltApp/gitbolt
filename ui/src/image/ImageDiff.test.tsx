import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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

  it('opens at 100%; Fit is still the first step (H23)', async () => {
    vi.stubGlobal('Image', FakeImage);
    render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('100%');
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '0' } });
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('Fit');
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

  it('background toggles at the far right: checkerboard by default, black, white, grey; remembered (H30)', () => {
    const { container } = render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} />);
    const group = screen.getByRole('group', { name: 'Image background' });
    expect(group.parentElement!.lastElementChild).toBe(group);
    const names = ['Checkerboard background', 'Black background', 'White background', 'Grey background'];
    expect([...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(names);
    expect(screen.getByRole('button', { name: 'Checkerboard background' })).toHaveAttribute('aria-pressed', 'true');
    const viewports = () => [...container.querySelectorAll('.image-viewport')].map((v) => v.className);
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
    expect(result.current).toEqual({ old: { url: 'blob:u1', size: 6 }, new: { url: 'blob:u2', size: 7 } });
    expect(revoke).not.toHaveBeenCalled();
    rerender({ c: contents('<svg/>', '<svg  />') });
    expect(revoke.mock.calls.map((c) => c[0])).toEqual(['blob:u1', 'blob:u2']);
    expect(result.current?.new?.url).toBe('blob:u4');
    unmount();
    expect(revoke.mock.calls.map((c) => c[0])).toEqual(['blob:u1', 'blob:u2', 'blob:u3', 'blob:u4']);
  });
});
