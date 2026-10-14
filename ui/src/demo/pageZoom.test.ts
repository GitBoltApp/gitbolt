// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installZoom, ZOOM_STORAGE_KEY } from '../ui/zoom';
import { applyPageZoom, pageZoomFactor } from './pageZoom';

// happy-dom does no layout: the browser's numbers, in viewport px, stand in for it. The shim wraps
// what it finds on its first use, so they go in first. (A mouse event's clientX is a plain field in
// happy-dom, not a getter; the demo e2e shows the pointer side, demo.spec.ts.)
const hit = document.createElement('div');
const fromPoint = vi.fn((_x: number, _y: number) => hit);
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () => new DOMRect(150, 75, 300, 60);
  Element.prototype.getClientRects = () => [new DOMRect(30, 15, 60, 3)] as unknown as DOMRectList;
  Document.prototype.elementFromPoint = fromPoint;
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
});

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  applyPageZoom(100);
  localStorage.clear();
});

describe('applyPageZoom', () => {
  it('zooms the root element with CSS zoom, and takes it off at 100%', () => {
    applyPageZoom(150);
    expect(document.documentElement.style.getPropertyValue('zoom')).toBe('1.5');
    expect(pageZoomFactor()).toBe(1.5);
    applyPageZoom(100);
    expect(document.documentElement.style.getPropertyValue('zoom')).toBe('');
    expect(pageZoomFactor()).toBe(1);
  });

  it('reports rects and the window in CSS px, as a page zoom does, and the zoom in devicePixelRatio', () => {
    applyPageZoom(150);
    const r = document.body.getBoundingClientRect();
    expect([r.x, r.y, r.width, r.height]).toEqual([100, 50, 200, 40]);
    const [first] = document.body.getClientRects();
    expect([first.x, first.y, first.width, first.height]).toEqual([20, 10, 40, 2]);
    expect(document.body.getClientRects()).toHaveLength(1);
    expect([window.innerWidth, window.innerHeight]).toEqual([800, 400]);
    expect(window.devicePixelRatio).toBe(3);
  });

  it('hands a point back to the browser in its own px', () => {
    applyPageZoom(200);
    fromPoint.mockClear();
    // Through Document's own method: happy-dom's document class has another of its own.
    expect(Document.prototype.elementFromPoint.call(document, 10, 20)).toBe(hit);
    expect(fromPoint).toHaveBeenCalledWith(20, 40);
  });

  it('leaves every number alone at 100%', () => {
    applyPageZoom(100);
    const r = document.body.getBoundingClientRect();
    expect([r.x, r.width]).toEqual([150, 300]);
    expect([window.innerWidth, window.devicePixelRatio]).toEqual([1200, 2]);
  });

  it('fires a resize when the zoom changes, so what measures the window measures again', () => {
    const onResize = vi.fn();
    window.addEventListener('resize', onResize);
    applyPageZoom(120);
    applyPageZoom(120);
    applyPageZoom(100);
    window.removeEventListener('resize', onResize);
    expect(onResize).toHaveBeenCalledTimes(2);
  });
});

describe('the demo zoom through installZoom', () => {
  it('applies the saved step at install (before the first render), then Ctrl+= steps it in', () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, '150');
    uninstall = installZoom(applyPageZoom);
    expect(document.documentElement.style.getPropertyValue('zoom')).toBe('1.5');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(document.documentElement.style.getPropertyValue('zoom')).toBe('1.75');
    expect(document.documentElement.dataset.zoom).toBe('175');
  });
});
