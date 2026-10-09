import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./setup', () => ({ monaco: { editor: { EditorOption: { lineHeight: 75 } } } }));

const { REVIEW_ZONE_ORDINAL, ReviewZones, layerClip, shiftAbove, zoneTarget } = await import('./reviewZones');

type Zone = { afterLineNumber: number; heightInPx: number; ordinal?: number; showInHiddenAreas?: boolean; onDomNodeTop?: (top: number) => void };
type Item = { key: string; side: 'original' | 'modified'; line: number; startLine: number | null; stop: boolean };
const item = (key: string, side: Item['side'], line: number, over: Partial<Item> = {}): Item => ({ key, side, line, startLine: null, stop: !key.startsWith('b:'), ...over });

/** An editor: 19 px lines (their bottoms at line × 19), a 500 px view, its box at `left`, 30 px down the layer. */
function fakeEditor(left: number) {
  const dom = document.createElement('div');
  vi.spyOn(dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(left, 30, 400, 500));
  let n = 0;
  const ed = {
    zones: new Map<string, Zone>(),
    /** Monaco's own zones (a deleted-lines block: ordinal 10000). */
    own: [] as { id: string; afterLineNumber: number; ordinal: number; height: number }[],
    decorations: [] as unknown[],
    scrollTop: 0,
    layoutZone: vi.fn(),
    render: vi.fn(),
    setScrollTop: vi.fn((top: number) => { ed.scrollTop = top; }),
    changeViewZones: (cb: (acc: { addZone(z: Zone): string; removeZone(id: string): void; layoutZone(id: string): void }) => void) => cb({
      addZone: (z) => { const id = `z${++n}`; ed.zones.set(id, z); return id; },
      removeZone: (id) => void ed.zones.delete(id),
      layoutZone: (id) => ed.layoutZone(id),
    }),
    createDecorationsCollection: () => ({ set: (d: unknown[]) => { ed.decorations = d; }, clear: () => { ed.decorations = []; } }),
    onDidLayoutChange: () => ({ dispose() {} }),
    getLayoutInfo: () => ({ contentLeft: 50, contentWidth: 350, verticalScrollbarWidth: 10, height: 500 }),
    getDomNode: () => dom,
    getBottomForLineNumber: (line: number) => line * 19,
    /** Every zone, Monaco's and the API's, in Monaco's order: by line, then ordinal. */
    getWhitespaces: () => [...ed.own, ...[...ed.zones].map(([id, z]) => ({ id, afterLineNumber: z.afterLineNumber, ordinal: z.ordinal ?? 0, height: z.heightInPx }))]
      .sort((a, b) => a.afterLineNumber - b.afterLineNumber || a.ordinal - b.ordinal),
    getScrollTop: () => ed.scrollTop,
    getOption: () => 19,
  };
  return ed;
}

/** Monaco's line changes, as `getLineChanges` gives them. */
type Change = { originalStartLineNumber: number; originalEndLineNumber: number; modifiedStartLineNumber: number; modifiedEndLineNumber: number };
const ch = (os: number, oe: number, ms: number, me: number): Change => ({ originalStartLineNumber: os, originalEndLineNumber: oe, modifiedStartLineNumber: ms, modifiedEndLineNumber: me });

const ro = vi.hoisted(() => ({ cb: null as null | ((entries: { target: Element }[]) => void) }));
let realRO: typeof ResizeObserver;
beforeEach(() => {
  realRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(cb: (entries: { target: Element }[]) => void) { ro.cb = cb; } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { globalThis.ResizeObserver = realRO; document.body.innerHTML = ''; });

function setup(changes: Change[] = []) {
  const original = fakeEditor(0);
  const modified = fakeEditor(400);
  const zones = new ReviewZones({ getOriginalEditor: () => original, getModifiedEditor: () => modified, getLineChanges: () => changes } as never);
  document.body.appendChild(zones.layer);
  const placed = vi.fn();
  const nodes = () => placed.mock.lastCall?.[0] as Map<string, HTMLElement>;
  return { zones, original, modified, placed, nodes };
}
const afters = (ed: ReturnType<typeof fakeEditor>) => [...ed.zones.values()].map((z) => z.afterLineNumber);

describe('where a card goes (spec 2026-10-08 §2)', () => {
  // Old 1-4 = new 1-4; old 5-6 deleted; old 7-10 = new 5-8; new 9-11 inserted after old 10;
  // old 11-19 = new 12-20; old 20-21 replaced by new 21; old 22 = new 22.
  const changes = [ch(5, 6, 4, 0), ch(10, 0, 9, 11), ch(20, 21, 21, 21)];

  it('a new-side card, and in Split an old-side one, sits under its own line', () => {
    expect(zoneTarget({ side: 'modified', line: 7 }, 'inline', changes)).toEqual({ side: 'modified', after: 7 });
    expect(zoneTarget({ side: 'original', line: 5 }, 'split', changes)).toEqual({ side: 'original', after: 5 });
  });

  it("Inline and Hunk: an old line's card goes under its deleted-lines block, or under the line it became", () => {
    expect(zoneTarget({ side: 'original', line: 6 }, 'inline', changes)).toEqual({ side: 'modified', after: 4 });
    expect(zoneTarget({ side: 'original', line: 21 }, 'hunk', changes)).toEqual({ side: 'modified', after: 20 });
    expect(zoneTarget({ side: 'original', line: 8 }, 'inline', changes)).toEqual({ side: 'modified', after: 6 });
    expect(zoneTarget({ side: 'original', line: 10 }, 'inline', changes)).toEqual({ side: 'modified', after: 8 });
    expect(zoneTarget({ side: 'original', line: 15 }, 'hunk', changes)).toEqual({ side: 'modified', after: 16 });
    expect(zoneTarget({ side: 'original', line: 22 }, 'inline', changes)).toEqual({ side: 'modified', after: 22 });
  });

  it('only cards that end above the view move it', () => {
    expect(shiftAbove([{ top: 76, from: 0, to: 80 }, { top: 760, from: 0, to: 60 }, { top: 100, from: 40, to: 0 }], 300)).toBe(40);
  });
});

describe('the card layer', () => {
  it("owns Esc (repo/escape.ts): an Esc in a card is the card's, not the diff's close", () => {
    expect(setup().zones.layer.hasAttribute('data-owns-escape')).toBe(true);
  });
});

describe("what the card layer leaves out: Monaco's find widget and sticky scroll", () => {
  it('nothing without a hole in it', () => {
    expect(layerClip(400, 300, [])).toBe('');
    expect(layerClip(400, 300, [{ left: 500, top: 0, right: 600, bottom: 35 }])).toBe('');
  });

  it('the find widget, at the top right: the rest of the layer, row by row', () => {
    expect(layerClip(400, 300, [{ left: 300, top: 0, right: 400, bottom: 35 }])).toBe("path('M0 0H300V35H0Z M0 35H400V300H0Z')");
  });

  it('sticky scroll and the find widget over it, in Split the other side clear; edges rounded outwards, clamped to the layer', () => {
    const holes = [{ left: 0, top: 0, right: 200, bottom: 19.5 }, { left: 120.4, top: -4, right: 200, bottom: 35 }];
    expect(layerClip(400, 300, holes)).toBe("path('M200 0H400V20H200Z M0 20H120V35H0Z M200 20H400V35H200Z M0 35H400V300H0Z')");
  });

  it('all of it covered: nothing shows', () => {
    expect(layerClip(400, 300, [{ left: 0, top: 0, right: 400, bottom: 300 }])).toBe('inset(50%)');
  });
});

describe('ReviewZones', () => {
  it("lays the shown file's cards under their lines, after Monaco's own zones, and hands the view their nodes", () => {
    const { zones, modified, placed, nodes } = setup();
    zones.set({ path: 'a.rs', items: [item('t:1', 'modified', 4), item('b:x', 'modified', 4)], placed });
    expect(modified.zones.size).toBe(0);
    zones.shown('a.rs', 'inline');
    expect([...modified.zones.values()].map((z) => [z.afterLineNumber, z.ordinal, z.showInHiddenAreas])).toEqual([[4, REVIEW_ZONE_ORDINAL, true], [4, REVIEW_ZONE_ORDINAL + 1, true]]);
    expect([...nodes().keys()]).toEqual(['t:1', 'b:x']);
    expect(nodes().get('t:1')!.parentElement).toBe(zones.layer);
    // Another file's diff: these cards go.
    zones.shown('b.rs', 'inline');
    expect(modified.zones.size).toBe(0);
    expect(nodes().size).toBe(0);
  });

  it("a card covers its editor's text area, clear of the scrollbar, at its zone's top", () => {
    const { zones, original, placed, nodes } = setup();
    zones.set({ path: 'a.rs', items: [item('t:1', 'original', 4)], placed });
    zones.shown('a.rs', 'split');
    [...original.zones.values()][0]!.onDomNodeTop!(120);
    const node = nodes().get('t:1')!;
    expect([node.style.left, node.style.width, node.style.top]).toEqual(['50px', '336px', '150px']);
  });

  it("a zone takes its card's height, drawn before the frame paints; one growing above the view keeps the lines in view still", () => {
    const { zones, modified, placed, nodes } = setup();
    zones.set({ path: 'a.rs', items: [item('t:1', 'modified', 4), item('t:2', 'modified', 40)], placed });
    zones.shown('a.rs', 'inline');
    modified.scrollTop = 300;
    const [n1, n2] = [...nodes().values()];
    Object.defineProperty(n1, 'offsetHeight', { value: 80, configurable: true });
    Object.defineProperty(n2, 'offsetHeight', { value: 60, configurable: true });
    ro.cb!([{ target: n1! }, { target: n2! }]);
    expect([...modified.zones.values()].map((z) => z.heightInPx)).toEqual([80, 60]);
    expect(modified.layoutZone).toHaveBeenCalledTimes(2);
    expect(modified.render).toHaveBeenCalledWith(true);
    // Line 4's card ends above the view (at 76 px): the view moves down by what it grew.
    expect(modified.setScrollTop).toHaveBeenLastCalledWith(380);
  });

  it("Inline puts an old line's card under its deleted block, Split under its line in the old editor: the same node", () => {
    const { zones, original, modified, placed, nodes } = setup([ch(9, 10, 9, 11)]);
    zones.set({ path: 'a.rs', items: [item('d:1', 'original', 10)], placed });
    zones.shown('a.rs', 'inline');
    expect(afters(modified)).toEqual([8]);
    const node = nodes().get('d:1');
    zones.shown('a.rs', 'split');
    expect(modified.zones.size).toBe(0);
    expect(afters(original)).toEqual([10]);
    expect(nodes().get('d:1')).toBe(node);
  });

  it("a range's lines are softly highlighted; Next / Previous thread step through the threads and drafts, not the boxes", () => {
    const { zones, modified, placed } = setup();
    zones.set({ path: 'a.rs', items: [item('t:1', 'modified', 8, { startLine: 5 }), item('b:x', 'modified', 30), item('t:2', 'modified', 60)], placed });
    zones.shown('a.rs', 'inline');
    expect(modified.decorations).toEqual([{ range: { startLineNumber: 5, startColumn: 1, endLineNumber: 8, endColumn: 1 }, options: { isWholeLine: true, className: 'review-range', marginClassName: 'review-range' } }]);
    // From the top: line 8's card is above the view's centre, so Next goes to line 60's.
    expect(zones.goTo('next', 57)).toBe('t:2');
    expect(modified.setScrollTop).toHaveBeenLastCalledWith(890);
    expect(zones.goTo('previous', 57)).toBe('t:1');
    expect(modified.setScrollTop).toHaveBeenLastCalledWith(0);
    zones.set(null);
    expect(modified.zones.size).toBe(0);
    expect(zones.goTo('next', 57)).toBeNull();
  });

  it("Next / Previous thread centre a card where it is: below Monaco's zones and the cards before it on its line", () => {
    const { zones, modified, placed, nodes } = setup();
    // Line 40's deleted-lines block (100 px), then its two cards (80 and 60 px).
    modified.own.push({ id: 'del', afterLineNumber: 40, ordinal: 10000, height: 100 });
    zones.set({ path: 'a.rs', items: [item('t:1', 'modified', 40), item('t:2', 'modified', 40)], placed });
    zones.shown('a.rs', 'inline');
    const [n1, n2] = [...nodes().values()];
    Object.defineProperty(n1, 'offsetHeight', { value: 80, configurable: true });
    Object.defineProperty(n2, 'offsetHeight', { value: 60, configurable: true });
    ro.cb!([{ target: n1! }, { target: n2! }]);
    // t:1 spans 860-940 (760 + the block), t:2 940-1000: each centred in the 500 px view.
    expect(zones.goTo('next', 57)).toBe('t:1');
    expect(modified.setScrollTop).toHaveBeenLastCalledWith(650);
    expect(zones.goTo('next', 57)).toBe('t:2');
    expect(modified.setScrollTop).toHaveBeenLastCalledWith(720);
  });

  it("leaves out the find widget once it shows, and sticky scroll's lines, as they come and go", async () => {
    const { zones, modified, placed } = setup();
    vi.spyOn(zones.layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 560));
    const overlays = modified.getDomNode().appendChild(document.createElement('div'));
    overlays.className = 'overlayWidgets';
    vi.spyOn(overlays, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 30, 400, 500));
    /** An overlay widget: at `left`, `top` in the editor's overlays, `w` × `h`. */
    const widget = (cls: string, left: number, top: number, w: number, h: number) => {
      const n = document.createElement('div');
      n.className = cls;
      for (const [k, v] of Object.entries({ offsetParent: overlays, offsetLeft: left, offsetTop: top, offsetWidth: w, offsetHeight: h })) Object.defineProperty(n, k, { value: v, configurable: true });
      return n;
    };
    zones.set({ path: 'a.rs', items: [item('t:1', 'modified', 1)], placed });
    zones.shown('a.rs', 'inline');
    expect(zones.layer.style.getPropertyValue('clip-path')).toBe('');
    // Monaco adds the find widget (hidden), then shows it.
    const find = overlays.appendChild(widget('editor-widget find-widget', 300, 0, 80, 33));
    await Promise.resolve();
    expect(zones.layer.style.getPropertyValue('clip-path')).toBe('');
    find.classList.add('visible');
    await Promise.resolve();
    expect(zones.layer.style.getPropertyValue('clip-path')).toBe("path('M0 0H800V30H0Z M0 30H700V63H0Z M780 30H800V63H780Z M0 63H800V560H0Z')");
    find.classList.remove('visible');
    await Promise.resolve();
    expect(zones.layer.style.getPropertyValue('clip-path')).toBe('');
    // Sticky scroll's lines (already there when the view was shown).
    const sticky = overlays.appendChild(widget('sticky-widget', 0, 0, 400, 38));
    await Promise.resolve();
    expect(zones.layer.style.getPropertyValue('clip-path')).toBe("path('M0 0H800V30H0Z M0 30H400V68H0Z M0 68H800V560H0Z')");
    Object.defineProperty(sticky, 'offsetHeight', { value: 0 });
    sticky.style.display = 'none';
    await Promise.resolve();
    expect(zones.layer.style.getPropertyValue('clip-path')).toBe('');
  });

  it('the wheel over a card scrolls the diff, unless what is under it scrolls itself', () => {
    const { zones, modified, placed, nodes } = setup();
    zones.set({ path: 'a.rs', items: [item('t:1', 'modified', 4)], placed });
    zones.shown('a.rs', 'inline');
    const node = nodes().get('t:1')!;
    const wheel = new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true });
    node.dispatchEvent(wheel);
    expect(modified.setScrollTop).toHaveBeenLastCalledWith(57);
    expect(wheel.defaultPrevented).toBe(true);
    const area = node.appendChild(document.createElement('textarea'));
    Object.defineProperty(area, 'scrollHeight', { value: 200 });
    Object.defineProperty(area, 'clientHeight', { value: 50 });
    const inner = new WheelEvent('wheel', { deltaY: 3, bubbles: true, cancelable: true });
    area.dispatchEvent(inner);
    expect(inner.defaultPrevented).toBe(false);
    expect(modified.setScrollTop).toHaveBeenCalledTimes(1);
  });
});
