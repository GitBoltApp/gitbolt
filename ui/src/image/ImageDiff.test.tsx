import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { ImageDiff } from './ImageDiff';
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ImageDiff', () => {
  it('offers only side-by-side for an added image, all modes for a changed one', () => {
    const { unmount } = render(<ImageDiff old={null} new={{ url: 'blob:new', size: 70 }} />);
    expect(screen.getByRole('button', { name: 'Swipe' })).toBeDisabled();
    expect(screen.getByTestId('image-size')).toHaveTextContent('— → 70 B');
    unmount();
    render(<ImageDiff old={{ url: 'blob:old', size: 60 }} new={{ url: 'blob:new', size: 70 }} source={<div>svg source</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));
    expect(screen.getByRole('slider', { name: 'Swipe position' })).toHaveAttribute('aria-valuenow', '50');
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Swipe position' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('slider', { name: 'Swipe position' })).toHaveAttribute('aria-valuenow', '45');
    fireEvent.click(screen.getByRole('button', { name: 'Onion skin' }));
    expect(screen.getByRole('slider', { name: 'Opacity' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '5' } });
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByText('svg source')).toBeInTheDocument();
  });

  it('keeps zoom and pan when the mode changes', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { container } = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '5' } });
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
    expect(container.querySelector<HTMLImageElement>('img.image-layer')!.style.transform).toContain('scale(4)');
    fireEvent.click(screen.getByRole('button', { name: 'Side-by-side' }));
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
  });

  it('Ctrl+wheel zooms in steps, is prevented, accumulates small deltas and ignores deltaY 0', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { container, unmount } = render(<ImageDiff old={{ url: 'blob:4x4', size: 60 }} new={{ url: 'blob:6x4', size: 70 }} />);
    await waitFor(() => expect(screen.getByTestId('image-dims')).toHaveTextContent('4×4 → 6×4'));
    const stage = container.querySelector('.image-stage')!;
    // jsdom has no layout, so Fit is scale 1: one notch in is 200%.
    expect(wheel(stage, 0).defaultPrevented).toBe(true);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('Fit');
    expect(wheel(stage, -100, false).defaultPrevented).toBe(false);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('Fit');
    expect(wheel(stage, -100).defaultPrevented).toBe(true);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('200%');
    // A trackpad pinch sends many small deltas: 100 px in total is two steps, not ten.
    for (let i = 0; i < 10; i++) wheel(stage, -10);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('600%');
    wheel(stage, 100);
    expect(screen.getByTestId('zoom-label')).toHaveTextContent('400%');
    unmount();
    // The native listener is gone with the component.
    expect(wheel(stage, -100).defaultPrevented).toBe(false);
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
