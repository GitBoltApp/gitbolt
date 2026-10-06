import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppState } from '../app/state';
import { useToast } from '../ui/toast';
import { installZoom, useZoom } from '../ui/zoom';
import { editorFontVar, installFontZoom, nextEditorFont, useEditorFontPx } from './fontZoom';

vi.mock('../api/client', () => ({ api: { saveSettings: vi.fn(async () => {}), saveProfile: vi.fn(async () => {}) }, errorMessage: String, onEvent: () => () => {} }));

const key = (k: string) => new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true });
const wheel = (deltaY: number, ctrlKey = true, deltaMode = 0) => new WheelEvent('wheel', { deltaY, ctrlKey, deltaMode, bubbles: true, cancelable: true });
const font = () => useAppState.getState().settings.editorFontSize;

describe('nextEditorFont', () => {
  it('steps 1 px in or out, clamped to 8-32; reset is 13 (Monaco\'s size)', () => {
    expect(nextEditorFont(13, 1)).toBe(14);
    expect(nextEditorFont(13, -1)).toBe(12);
    expect(nextEditorFont(32, 1)).toBe(32);
    expect(nextEditorFont(8, -1)).toBe(8);
    expect(nextEditorFont(20, 0)).toBe(13);
    expect(nextEditorFont(Number.NaN, 1)).toBe(14);
  });
});

describe('the rendered Markdown font size', () => {
  it('follows editorFontSize, clamped, as the panes\' --md-font-size', () => {
    expect(editorFontVar(15)).toEqual({ '--md-font-size': '15px' });
    expect(editorFontVar(99)).toEqual({ '--md-font-size': '32px' });
    useAppState.getState().setSettings({ editorFontSize: 17 });
    const { result } = renderHook(() => useEditorFontPx());
    expect(result.current).toBe(17);
  });
});

describe('installFontZoom', () => {
  let off: (() => void)[] = [];
  let panel: HTMLElement;
  let inner: HTMLElement;
  let outside: HTMLElement;
  beforeEach(() => {
    useAppState.getState().setSettings({ editorFontSize: 13 });
    useToast.setState({ message: null });
    document.body.innerHTML = '<div data-font-zoom><div tabindex="-1" id="inner">text</div></div><div tabindex="-1" id="outside">other</div>';
    panel = document.querySelector('[data-font-zoom]')!;
    inner = document.getElementById('inner')!;
    outside = document.getElementById('outside')!;
    off = [installZoom(() => {}), installFontZoom()];
  });
  afterEach(() => {
    for (const f of off) f();
    document.body.innerHTML = '';
  });

  it('Ctrl+= / Ctrl+- / Ctrl+0 in the panel change the text size, not the app zoom, and say so', () => {
    const zoom = useZoom.getState().zoom;
    inner.dispatchEvent(key('='));
    inner.dispatchEvent(key('='));
    expect(font()).toBe(15);
    expect(useToast.getState().message).toBe('Text size 15 px');
    inner.dispatchEvent(key('-'));
    expect(font()).toBe(14);
    inner.dispatchEvent(key('0'));
    expect(font()).toBe(13);
    expect(useZoom.getState().zoom).toBe(zoom);
    expect(panel).toBeTruthy();
  });

  it('outside the panel, the keys still zoom the app', () => {
    const zoom = useZoom.getState().zoom;
    outside.dispatchEvent(key('='));
    expect(useZoom.getState().zoom).toBeGreaterThan(zoom);
    expect(font()).toBe(13);
    outside.dispatchEvent(key('0'));
  });

  it('Ctrl+wheel over the panel steps the size once per notch; a touchpad\'s small deltas add up', () => {
    const e = wheel(-100);
    inner.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(font()).toBe(14);
    inner.dispatchEvent(wheel(100));
    inner.dispatchEvent(wheel(100));
    expect(font()).toBe(12);
    for (let i = 0; i < 4; i++) inner.dispatchEvent(wheel(-10));
    expect(font()).toBe(12);
    for (let i = 0; i < 2; i++) inner.dispatchEvent(wheel(-10));
    expect(font()).toBe(13);
    // Lines, not pixels (Firefox's mode 1): one line is a step too.
    inner.dispatchEvent(wheel(-3, true, 1));
    expect(font()).toBe(14);
  });

  it('a plain wheel, or Ctrl+wheel elsewhere, leaves the size alone', () => {
    const plain = wheel(-100, false);
    inner.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    outside.dispatchEvent(wheel(-100));
    expect(font()).toBe(13);
  });
});
