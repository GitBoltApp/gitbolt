import { describe, expect, it } from 'vitest';
import { THEMES } from '../theme/themes';
import { editorColors } from './monaco/theme';
import { dragScrollTop, LANE_WIDTH, markKind, markRects, MIN_MARK_PX, MIN_SLIDER_PX, RULER_WIDTH, rulerColors, scrollTopAt, sliderOf, wheelPixels } from './mdRuler';

describe('the rendered diff overview ruler: geometry', () => {
  it("is as wide as Monaco's diff overview (two 15 px lanes)", () => {
    expect(RULER_WIDTH).toBe(30);
    expect(LANE_WIDTH).toBe(15);
  });

  it('places a mark proportionally to its offset in the scroll content', () => {
    // 2000 px of content on a 500 px strip: a quarter.
    const [r] = markRects([{ top: 400, height: 80, kind: 'added' }], 2000, 500, false);
    expect(r).toMatchObject({ y: 100, h: 20 });
  });

  it('gives a tiny change the minimum height, centred on it, and keeps it inside the strip', () => {
    const [mid] = markRects([{ top: 1000, height: 1, kind: 'changed' }], 2000, 500, false);
    expect(mid!.h).toBe(MIN_MARK_PX);
    expect(mid!.y).toBe(249);
    const [top] = markRects([{ top: 0, height: 0, kind: 'changed' }], 2000, 500, false);
    expect(top!.y).toBe(0);
    expect(top!.h).toBe(MIN_MARK_PX);
    const [bottom] = markRects([{ top: 2000, height: 0, kind: 'changed' }], 2000, 500, false);
    expect(bottom!.y + bottom!.h).toBe(500);
  });

  it('Inline: every mark spans the strip', () => {
    const rs = markRects([{ top: 0, height: 10, kind: 'removed' }, { top: 20, height: 10, kind: 'added' }, { top: 40, height: 10, kind: 'changed' }], 100, 100, false);
    expect(rs.map((r) => [r.x, r.w])).toEqual([[0, 30], [0, 30], [0, 30]]);
  });

  it("Split: removed on the left half, added on the right, changed full width (Monaco's side-by-side)", () => {
    const rs = markRects([{ top: 0, height: 10, kind: 'removed' }, { top: 20, height: 10, kind: 'added' }, { top: 40, height: 10, kind: 'changed' }], 100, 100, true);
    expect(rs.map((r) => [r.x, r.w, r.kind])).toEqual([[0, 15, 'removed'], [15, 15, 'added'], [0, 30, 'changed']]);
  });

  it('no content height: no marks', () => {
    expect(markRects([{ top: 0, height: 10, kind: 'added' }], 0, 100, false)).toEqual([]);
  });

  it('a mark kind from the diff marks the stepper counts (a diagram pair is a change)', () => {
    expect(markKind('added')).toBe('added');
    expect(markKind('removed')).toBe('removed');
    expect(markKind('changed')).toBe('changed');
    expect(markKind('pair')).toBe('changed');
    expect(markKind(undefined)).toBeNull();
    expect(markKind('row:added')).toBeNull();
  });
});

describe('the viewport slider (Monaco ScrollbarState)', () => {
  it('is proportional to the visible part, at the scroll position', () => {
    const s = sliderOf(500, 2000, 0, 500);
    expect(s).toMatchObject({ needed: true, top: 0, height: 125 });
    expect(sliderOf(500, 2000, 1500, 500).top).toBe(375);
    expect(sliderOf(500, 2000, 750, 500).top).toBe(188);
  });

  it('is at least 20 px tall', () => {
    expect(sliderOf(500, 1_000_000, 0, 500).height).toBe(MIN_SLIDER_PX);
    expect(sliderOf(500, 1_000_000, 999_500, 500).top).toBe(480);
  });

  it('nothing to scroll: the slider covers the strip and is not needed', () => {
    expect(sliderOf(500, 400, 0, 500)).toMatchObject({ needed: false, top: 0, height: 500 });
  });
});

describe('pointer and wheel on the strip', () => {
  it('a click centres the view on that point', () => {
    // A 125 px slider centred at y=250 → its top at 187.5 → scrollTop 750: the content's middle.
    expect(scrollTopAt(250, 500, 2000, 500)).toBe(750);
    expect(scrollTopAt(0, 500, 2000, 500)).toBe(0);
    expect(scrollTopAt(500, 500, 2000, 500)).toBe(1500);
  });

  it('a click with nothing to scroll stays at the top', () => {
    expect(scrollTopAt(300, 500, 400, 500)).toBe(0);
  });

  it('dragging the slider moves the view by the slider ratio, clamped', () => {
    // ratio (500 - 125) / (2000 - 500) = 0.25: 10 px of drag is 40 px of content.
    expect(dragScrollTop(100, 10, 500, 2000, 500)).toBe(140);
    expect(dragScrollTop(100, -1000, 500, 2000, 500)).toBe(0);
    expect(dragScrollTop(100, 1000, 500, 2000, 500)).toBe(1500);
  });

  it('the wheel: pixels as they are, lines and pages scaled', () => {
    expect(wheelPixels({ deltaY: 30, deltaMode: 0 }, 400)).toBe(30);
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 }, 400)).toBe(48);
    expect(wheelPixels({ deltaY: -1, deltaMode: 2 }, 400)).toBe(-400);
  });
});

describe('the ruler colours follow the theme', () => {
  it("added and removed are Monaco's diff overview colours; changed is the theme's modified tone at the same alpha", () => {
    for (const id of ['default-dark', 'light'] as const) {
      const def = THEMES[id];
      const c = rulerColors(def);
      expect(c.added).toBe(editorColors(def)['diffEditorOverview.insertedForeground']);
      expect(c.removed).toBe(editorColors(def)['diffEditorOverview.removedForeground']);
      expect(c.changed).toBe(`${def.colors['status-modified'].toLowerCase()}99`);
    }
  });

  it("the strip has no ground of its own: Monaco's .diffOverview is transparent on the app's themes (measured)", () => {
    for (const def of [THEMES['default-dark'], THEMES.light]) expect(rulerColors(def)).not.toHaveProperty('ground');
  });
});
