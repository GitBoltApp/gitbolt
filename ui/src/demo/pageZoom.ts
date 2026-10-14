/**
 * The app zoom in the website demo (Ctrl+= / Ctrl+- / Ctrl+0 and the status bar's step list,
 * ui/zoom.ts). The desktop app zooms the webview, which a page can't do to itself, so the demo
 * zooms its root element with CSS `zoom` instead.
 *
 * The app is written for page zoom, where layout, pointer and measuring all share one unit, the
 * CSS px, and `devicePixelRatio` includes the zoom (graph/pixels.ts). CSS zoom on the root keeps
 * the browser's own px for what it reports: a mouse event's `clientX`, `getBoundingClientRect`
 * and `innerWidth` come in viewport px (the zoom times the CSS px that styles are laid out in),
 * the point-taking APIs (`elementFromPoint`) want them, and `devicePixelRatio` leaves the zoom
 * out. So while zoomed, the demo restores page zoom's picture: those reads are divided by the zoom
 * (`devicePixelRatio` multiplied by it), and the points given back are multiplied. A context
 * menu placed at a click's `clientX`, a column dragged by `clientX` deltas, or a canvas sized by
 * `devicePixelRatio` then land as in the desktop app. At 100% nothing is scaled.
 */

let factor = 1;

/** The demo's CSS zoom as a factor: 1 at 100%, and always 1 in the desktop app. */
export const pageZoomFactor = (): number => factor;

let patched = false;

type Proto = Record<string, unknown>;

/** Redefines `key` on `target` (found there or up its prototype chain) as a getter reading the
 * original's value through `scale`. Missing, or not a getter: left alone. */
function wrapGetter(target: object, key: string, scale: (v: number) => number): void {
  for (let o: object | null = target; o; o = Object.getPrototypeOf(o) as object | null) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (!d) continue;
    const get = d.get;
    if (!get) return;
    Object.defineProperty(target, key, { configurable: true, enumerable: d.enumerable, get(this: unknown) { return scale(get.call(this) as number); } });
    return;
  }
}

/** Wraps the method `key` of `proto`, if it has one. */
function wrapMethod(proto: object | undefined, key: string, wrap: (orig: (...args: unknown[]) => unknown) => (this: unknown, ...args: unknown[]) => unknown): void {
  const orig = proto && (proto as Proto)[key];
  if (typeof orig === 'function') (proto as Proto)[key] = wrap(orig as (...args: unknown[]) => unknown);
}

const toCss = (v: number) => (factor === 1 ? v : v / factor);
const scaleRect = (r: DOMRect) => (factor === 1 ? r : new DOMRect(r.x / factor, r.y / factor, r.width / factor, r.height / factor));
const scaleRects = (list: DOMRectList): DOMRectList => {
  if (factor === 1) return list;
  const rects = Array.from(list, scaleRect);
  return Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList;
};

function patchOnce(): void {
  if (patched) return;
  patched = true;
  for (const key of ['clientX', 'clientY', 'x', 'y', 'pageX', 'pageY']) wrapGetter(MouseEvent.prototype, key, toCss);
  for (const key of ['innerWidth', 'innerHeight']) wrapGetter(window, key, toCss);
  wrapGetter(window, 'devicePixelRatio', (v) => v * factor);
  for (const proto of [Element.prototype, Range.prototype]) {
    wrapMethod(proto, 'getBoundingClientRect', (orig) => function (this: unknown) { return scaleRect(orig.call(this) as DOMRect); });
    wrapMethod(proto, 'getClientRects', (orig) => function (this: unknown) { return scaleRects(orig.call(this) as DOMRectList); });
  }
  wrapMethod(globalThis.CaretPosition?.prototype, 'getClientRect', (orig) => function (this: unknown) {
    const r = orig.call(this) as DOMRect | null;
    return r && scaleRect(r);
  });
  const atPoint = (orig: (...args: unknown[]) => unknown) => function (this: unknown, x: unknown, y: unknown, ...rest: unknown[]) {
    return orig.call(this, (x as number) * factor, (y as number) * factor, ...rest);
  };
  for (const proto of [Document.prototype, globalThis.ShadowRoot?.prototype]) {
    for (const key of ['elementFromPoint', 'elementsFromPoint', 'caretRangeFromPoint', 'caretPositionFromPoint']) wrapMethod(proto, key, atPoint);
  }
}

/**
 * Zooms the demo to `pct` (one of ui/zoom.ts's steps): the applier `installZoom` takes in the
 * demo build (main.tsx). Called before the first render with the saved step, so it applies from
 * the first paint. A `resize` follows, as it does for a page zoom: what measures the window (the
 * graph's device pixel ratio among them) measures again.
 */
export function applyPageZoom(pct: number): void {
  patchOnce();
  const next = pct / 100;
  const root = document.documentElement;
  if (next === 1) root.style.removeProperty('zoom');
  else root.style.setProperty('zoom', String(next));
  if (next === factor) return;
  factor = next;
  window.dispatchEvent(new Event('resize'));
}
