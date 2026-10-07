import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('../markdown/actions', () => actions);
const copy = vi.hoisted(() => ({ copyImage: vi.fn(async () => {}) }));
vi.mock('../image/copyImage', () => copy);

const { Lightbox } = await import('./Lightbox');
const { openLightbox, useLightbox } = await import('./store');
const { registerKeys } = await import('../ui/keyRouter');
const { useToast } = await import('../ui/toast');

const URL_ = 'data:image/png;base64,iVBORw==';

function setWindow(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

/** Opens the viewer on an image of `w`×`h` (jsdom decodes nothing: the size is set, then `load`). */
function show(w: number, h: number, browserUrl: string | null = 'https://gitlab.example.com/-/project/42/uploads/0123abcd0123abcd/shot.png') {
  act(() => openLightbox({ kind: 'image', url: URL_, alt: 'shot', browserUrl }));
  const img = screen.getByAltText('shot') as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h });
  fireEvent.load(img);
  return img;
}

const zoomLabel = () => screen.getByTestId('lightbox-zoom').textContent;
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init });

beforeEach(() => {
  vi.clearAllMocks();
  setWindow(1000, 800);
  useLightbox.setState({ item: null });
});
afterEach(() => act(() => useLightbox.getState().close()));

describe('Lightbox: the image viewer', () => {
  it('covers the window as a dialog; an image that fits opens at 100%, centred', () => {
    render(<Lightbox />);
    expect(screen.queryByRole('dialog')).toBeNull();
    const img = show(400, 300);
    expect(screen.getByRole('dialog', { name: 'Image viewer: shot' })).toBeInTheDocument();
    expect(zoomLabel()).toBe('100%');
    expect(img.style.transform).toBe('translate(300px, 250px) scale(1)');
  });

  it('a larger image opens fitted to the window', () => {
    render(<Lightbox />);
    const img = show(4000, 1000);
    expect(zoomLabel()).toBe('25%');
    expect(img.style.transform).toBe('translate(0px, 275px) scale(0.25)');
  });

  it('+ / - step the zoom, 1 is 100%, 0 fits; the buttons do the same', () => {
    render(<Lightbox />);
    show(4000, 1000);
    key('+');
    expect(zoomLabel()).toBe('33%');
    key('-');
    key('-');
    expect(zoomLabel()).toBe('10%');
    key('1');
    expect(zoomLabel()).toBe('100%');
    key('0');
    expect(zoomLabel()).toBe('25%');
    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(zoomLabel()).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(zoomLabel()).toBe('25%');
  });

  it('the wheel zooms around the pointer; past 100% pixels stay sharp', () => {
    render(<Lightbox />);
    const img = show(100, 100);
    const stage = screen.getByTestId('lightbox-stage');
    fireEvent.wheel(stage, { deltaY: -100, clientX: 450, clientY: 350 });
    expect(zoomLabel()).toBe('110%');
    // Still smaller than the window: centred.
    expect(img.style.transform).toBe('translate(445px, 345px) scale(1.1)');
    expect(img.style.imageRendering).toBe('pixelated');
    fireEvent.wheel(stage, { deltaY: 100, clientX: 450, clientY: 350 });
    expect(zoomLabel()).toBe('100%');
    expect(img.style.imageRendering).toBe('auto');
  });

  it('zooming a wide image keeps the point under the pointer where it is', () => {
    render(<Lightbox />);
    const img = show(4000, 1000);
    // At 25%, (100, 400) is the image's (400, 500); at 33% that's still at x = 100.
    fireEvent.wheel(screen.getByTestId('lightbox-stage'), { deltaY: -100, clientX: 100, clientY: 400 });
    expect(zoomLabel()).toBe('33%');
    const [x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(img.style.transform)!.slice(1).map(Number);
    expect(x).toBeCloseTo(100 - 400 * 0.33);
    expect(y).toBeCloseTo((800 - 1000 * 0.33) / 2);
  });

  it('pans with the arrows and a drag only where the image is larger than the window', () => {
    render(<Lightbox />);
    const img = show(4000, 1000);
    key('ArrowRight');
    expect(img.style.transform).toBe('translate(0px, 275px) scale(0.25)');
    expect(img).not.toHaveClass('lightbox-pannable');
    key('1');
    // 100%: zoomed around the window's centre, then kept covering it.
    const at = () => img.style.transform;
    const before = at();
    key('ArrowRight');
    expect(at()).not.toBe(before);
    expect(img).toHaveClass('lightbox-pannable');
    fireEvent.pointerDown(img, { button: 0, clientX: 500, clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(img, { clientX: 550, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(img, { pointerId: 1 });
    expect(at()).toBe(before);
  });

  it('Esc closes and gives the focus back; app keys behind it never fire', () => {
    const app = vi.fn(() => 'handled' as const);
    const off = registerKeys('app', app);
    render(<><button type="button">opener</button><Lightbox /></>);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    show(400, 300);
    expect(document.activeElement).not.toBe(opener);
    key('w', { ctrlKey: true });
    key('ArrowLeft');
    expect(app).not.toHaveBeenCalled();
    key('Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    off();
  });

  it('a click on the backdrop closes it; a click on the image or the toolbar does not', () => {
    render(<Lightbox />);
    const img = show(400, 300);
    fireEvent.pointerDown(img, { button: 0 });
    fireEvent.click(img);
    fireEvent.click(screen.getByTestId('lightbox-zoom'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const stage = screen.getByTestId('lightbox-stage');
    fireEvent.pointerDown(stage, { button: 0 });
    fireEvent.click(stage);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('× closes', () => {
    render(<Lightbox />);
    show(400, 300);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Copy image copies the loaded image; Open in browser opens its web address, only when it has one', async () => {
    render(<Lightbox />);
    show(400, 300);
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }));
    expect(copy.copyImage).toHaveBeenCalledWith({ url: URL_, size: 0 });
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Image copied'));
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(actions.openExternal).toHaveBeenCalledWith('https://gitlab.example.com/-/project/42/uploads/0123abcd0123abcd/shot.png');
    act(() => useLightbox.getState().close());
    show(400, 300, null);
    expect(screen.queryByRole('button', { name: 'Open in browser' })).toBeNull();
  });

  it('plays a video: autoplay with controls, at 100% or fitted, sized (not scaled) so its controls stay readable; no zoom steps; Esc stops it', () => {
    render(<Lightbox />);
    act(() => openLightbox({ kind: 'video', url: 'blob:video-1', alt: 'clip', browserUrl: null }));
    expect(screen.getByRole('dialog', { name: 'Video viewer: clip' })).toBeInTheDocument();
    const v = document.querySelector('video')!;
    expect(v).toHaveAttribute('controls');
    expect(v.autoplay).toBe(true);
    Object.defineProperty(v, 'videoWidth', { configurable: true, value: 2000 });
    Object.defineProperty(v, 'videoHeight', { configurable: true, value: 1000 });
    fireEvent.loadedMetadata(v);
    expect(zoomLabel()).toBe('50%');
    expect([v.style.width, v.style.height, v.style.transform]).toEqual(['1000px', '500px', 'translate(0px, 150px)']);
    key('+');
    expect(zoomLabel()).toBe('50%');
    key('1');
    expect(zoomLabel()).toBe('100%');
    expect(screen.queryByRole('button', { name: 'Copy image' })).toBeNull();
    const pause = vi.spyOn(v, 'pause').mockImplementation(() => {});
    key('Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pause).toHaveBeenCalled();
  });
});
