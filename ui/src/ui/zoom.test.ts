import { afterEach, describe, expect, it, vi } from 'vitest';
import { installZoom, nextZoom, parseZoom, setZoom, useZoom, ZOOM_STEPS, ZOOM_STORAGE_KEY, zoomDirection } from './zoom';

const key = (key: string, mods: Partial<KeyboardEventInit> = {}) => new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...mods });

describe('zoom steps', () => {
  it('are the spec §12.2 steps', () => {
    expect(ZOOM_STEPS).toEqual([80, 90, 100, 110, 120, 130, 140, 150, 175, 200, 250, 300]);
  });

  it('step in and out one step at a time, clamped at both ends; reset goes to 100', () => {
    expect(nextZoom(100, 1)).toBe(110);
    expect(nextZoom(150, 1)).toBe(175);
    expect(nextZoom(250, 1)).toBe(300);
    expect(nextZoom(300, 1)).toBe(300);
    expect(nextZoom(100, -1)).toBe(90);
    expect(nextZoom(175, -1)).toBe(150);
    expect(nextZoom(80, -1)).toBe(80);
    expect(nextZoom(250, 0)).toBe(100);
  });

  it('a value between steps moves to the next step in that direction', () => {
    expect(nextZoom(105, 1)).toBe(110);
    expect(nextZoom(105, -1)).toBe(100);
    expect(nextZoom(1000, -1)).toBe(300);
    expect(nextZoom(10, 1)).toBe(80);
  });

  it('parses only a stored step', () => {
    expect(parseZoom('125')).toBeNull();
    expect(parseZoom('175')).toBe(175);
    expect(parseZoom(null)).toBeNull();
    expect(parseZoom('abc')).toBeNull();
  });
});

describe('zoomDirection', () => {
  it('reads Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0, and the numpad keys', () => {
    expect(zoomDirection(key('='))).toBe(1);
    expect(zoomDirection(key('+', { shiftKey: true }))).toBe(1);
    expect(zoomDirection(key('-'))).toBe(-1);
    expect(zoomDirection(key('0'))).toBe(0);
    expect(zoomDirection(key('+', { code: 'NumpadAdd' }))).toBe(1);
    expect(zoomDirection(key('-', { code: 'NumpadSubtract' }))).toBe(-1);
    expect(zoomDirection(key('0', { code: 'Numpad0' }))).toBe(0);
  });

  it('ignores the keys without Ctrl, or with Alt or Meta, and every other key', () => {
    expect(zoomDirection(key('=', { ctrlKey: false }))).toBeNull();
    expect(zoomDirection(key('=', { altKey: true }))).toBeNull();
    expect(zoomDirection(key('=', { metaKey: true }))).toBeNull();
    expect(zoomDirection(key('c'))).toBeNull();
    expect(zoomDirection(key('F7', { ctrlKey: false }))).toBeNull();
  });
});

describe('installZoom', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    localStorage.clear();
  });

  it('applies the saved zoom at startup (100 when none), steps on the keys, and saves each step', () => {
    const apply = vi.fn();
    localStorage.setItem(ZOOM_STORAGE_KEY, '120');
    uninstall = installZoom(apply);
    expect(apply).toHaveBeenLastCalledWith(120);
    const e = key('=');
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(apply).toHaveBeenLastCalledWith(130);
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('130');
    document.body.dispatchEvent(key('0'));
    expect(apply).toHaveBeenLastCalledWith(100);
    expect(document.documentElement.dataset.zoom).toBe('100');
    uninstall();
    uninstall = undefined;
    apply.mockClear();
    localStorage.clear();
    uninstall = installZoom(apply);
    expect(apply).toHaveBeenLastCalledWith(100);
  });

  it('leaves other keys alone', () => {
    const apply = vi.fn();
    uninstall = installZoom(apply);
    apply.mockClear();
    const e = key('c');
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('cancels Ctrl+wheel everywhere, so the webview never zooms itself; a plain wheel scrolls', () => {
    uninstall = installZoom(vi.fn());
    const ctrl = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    const plain = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    document.body.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });

  it('keeps working when storage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const apply = vi.fn();
    uninstall = installZoom(apply);
    expect(apply).toHaveBeenLastCalledWith(100);
    document.body.dispatchEvent(key('-'));
    expect(apply).toHaveBeenLastCalledWith(90);
    get.mockRestore();
    set.mockRestore();
  });

  it('useZoom follows the keys and setZoom (the status bar\'s step list), which applies and saves', () => {
    const apply = vi.fn();
    localStorage.setItem(ZOOM_STORAGE_KEY, '120');
    uninstall = installZoom(apply);
    expect(useZoom.getState().zoom).toBe(120);
    document.body.dispatchEvent(key('='));
    expect(useZoom.getState().zoom).toBe(130);
    setZoom(250);
    expect(useZoom.getState().zoom).toBe(250);
    expect(apply).toHaveBeenLastCalledWith(250);
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('250');
    expect(document.documentElement.dataset.zoom).toBe('250');
    // The keys step on from the picked zoom.
    document.body.dispatchEvent(key('-'));
    expect(apply).toHaveBeenLastCalledWith(200);
    // Uninstalled: setZoom no longer calls this install's apply (back to the webview's).
    uninstall();
    uninstall = undefined;
    apply.mockClear();
    setZoom(100);
    expect(apply).not.toHaveBeenCalled();
  });
});
