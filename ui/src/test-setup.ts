import { afterEach, beforeAll } from 'vitest';

// Dates format in en-US when the code asks for the default locale, so a test sees the same text on
// every machine ("8:56 AM", never en-CA's "8:56 a.m."). LANG can't pin it: Windows ignores it.
for (const m of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
  const format = Date.prototype[m];
  Date.prototype[m] = function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    const fallback = locales === undefined || (Array.isArray(locales) && locales.length === 0);
    return format.call(this, fallback ? 'en-US' : locales, options);
  };
}

// The rest is for tests in a DOM (jsdom: every .tsx test, and a .ts one that asks for it); the
// logic tests run in plain Node without it, and without paying for its imports.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');

  // vite.config.ts doesn't set `test.globals`, so testing-library's own auto-cleanup (which
  // detects a global `afterEach`) never registers. Without this, each render() in a test file
  // piles onto the previous one's DOM, and later `getByRole` queries see duplicates.
  afterEach(() => cleanup());

  // Every test file starts with the lazy Markdown chunk loaded: its first import in a worker
  // (remark, rehype, Shiki, the forge stores) outlasted findBy*'s timeout in loaded full runs, and
  // `<Markdown>` then renders its body on the first paint. In beforeAll, not at the top level: the
  // test file's vi.mock calls are registered by then, so the chunk's modules see its mocks. A file
  // that mocks the chunk (or a module it needs) just skips the warm-up.
  beforeAll(async () => {
    try { await (await import('./markdown/lazy')).preloadMarkdown(); } catch { /* not preloaded */ }
  }, 30_000);

  // happy-dom's WheelEvent drops its init's modifier keys and pointer position (ctrlKey and
  // clientX read undefined), which Ctrl+wheel zoom and zoom-at-the-pointer tests need.
  const probe = new WheelEvent('wheel', { ctrlKey: true, clientX: 1 });
  if (!probe.ctrlKey || probe.clientX !== 1) {
    const Wheel = globalThis.WheelEvent;
    globalThis.WheelEvent = class extends Wheel {
      constructor(type: string, init: WheelEventInit = {}) {
        super(type, init);
        for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'] as const) Object.defineProperty(this, k, { value: !!init[k] });
        for (const k of ['clientX', 'clientY', 'screenX', 'screenY'] as const) Object.defineProperty(this, k, { value: init[k] ?? 0 });
      }
    };
  }

  // happy-dom's getModifierState('AltGraph') answers altKey, so every Alt chord reads as AltGr (the
  // shortcut parser ignores those); a browser reports AltGr only when it's held (modifierAltGraph).
  if (new KeyboardEvent('keydown', { altKey: true }).getModifierState('AltGraph')) {
    const Key = globalThis.KeyboardEvent;
    globalThis.KeyboardEvent = class extends Key {
      constructor(type: string, init: KeyboardEventInit & { modifierAltGraph?: boolean } = {}) {
        super(type, init);
        const altGraph = !!init.modifierAltGraph;
        const state = this.getModifierState.bind(this);
        Object.defineProperty(this, 'getModifierState', { value: (k: string) => (k === 'AltGraph' ? altGraph : state(k)) });
      }
    };
  }

  // happy-dom's getClientRects always reports one box, even for a `hidden` element (a closed
  // context menu counted as shown). A browser has none for an element that isn't rendered.
  const clientRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function getClientRects(this: Element) {
    return this.isConnected && !this.closest('[hidden]') ? clientRects.call(this) : ([] as unknown as DOMRectList);
  };

  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo ??= function scrollTo() {} as typeof Element.prototype.scrollTo;

  // jsdom does no layout, so offsetWidth/offsetHeight (and clientHeight) are always 0. That
  // clobbers @tanstack/react-virtual's `initialRect` on mount (its default `observeElementRect`
  // measures the scroll element via offsetWidth/offsetHeight), leaving no rows virtualized.
  // Report a plausible viewport size instead so components under test render their rows.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1200 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
}
