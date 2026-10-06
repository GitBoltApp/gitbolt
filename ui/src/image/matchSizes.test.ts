import { describe, expect, it } from 'vitest';
import { aspectsMatch, defaultMatch, matchedRect, matchScale, rememberedMatch, rememberMatch, sizesDiffer } from './matchSizes';

describe('Match sizes', () => {
  it('applies only when both sizes are known and differ', () => {
    expect(sizesDiffer({ w: 3200, h: 2000 }, { w: 1600, h: 1000 })).toBe(true);
    expect(sizesDiffer({ w: 4, h: 4 }, { w: 4, h: 4 })).toBe(false);
    expect(sizesDiffer(null, { w: 4, h: 4 })).toBe(false);
    expect(sizesDiffer({ w: 4, h: 4 }, null)).toBe(false);
  });

  it('defaults on for a pure resize (aspect ratios within 1%), off otherwise', () => {
    expect(defaultMatch({ w: 3200, h: 2000 }, { w: 1600, h: 1000 })).toBe(true);
    // 1600×1000 vs 1600×1009: 0.9% apart, still a resize (rounding when it was scaled).
    expect(aspectsMatch({ w: 1600, h: 1000 }, { w: 1600, h: 1009 })).toBe(true);
    expect(defaultMatch({ w: 1600, h: 1000 }, { w: 800, h: 504 })).toBe(true);
    // 1.5% apart: a crop or a different image, not a resize.
    expect(aspectsMatch({ w: 1600, h: 1000 }, { w: 1600, h: 1015 })).toBe(false);
    expect(defaultMatch({ w: 4, h: 4 }, { w: 6, h: 4 })).toBe(false);
    // The same size: nothing to match.
    expect(defaultMatch({ w: 4, h: 4 }, { w: 4, h: 4 })).toBe(false);
  });

  it('the scale factor takes the old image to the new one', () => {
    expect(matchScale({ w: 3200, h: 2000 }, { w: 1600, h: 1000 })).toBe(0.5);
    expect(matchScale({ w: 100, h: 50 }, { w: 300, h: 150 })).toBe(3);
    // Different aspect ratios: the contain fit's factor (the tighter axis).
    expect(matchScale({ w: 4, h: 4 }, { w: 6, h: 4 })).toBe(1);
    expect(matchScale({ w: 200, h: 100 }, { w: 100, h: 100 })).toBe(0.5);
  });

  it("a pure resize fills the new image's box exactly", () => {
    expect(matchedRect({ w: 3200, h: 2000 }, { w: 1600, h: 1000 })).toEqual({ x: 0, y: 0, w: 1600, h: 1000 });
    // Within 1%: stretched to the box, no sliver of letterbox.
    expect(matchedRect({ w: 1600, h: 1009 }, { w: 800, h: 500 })).toEqual({ x: 0, y: 0, w: 800, h: 500 });
  });

  it("different aspect ratios fit the old image into the new one's box (contain), centred", () => {
    // Taller than the box: pillarboxed.
    expect(matchedRect({ w: 4, h: 4 }, { w: 6, h: 4 })).toEqual({ x: 1, y: 0, w: 4, h: 4 });
    // Wider than the box: letterboxed.
    expect(matchedRect({ w: 200, h: 100 }, { w: 100, h: 100 })).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    expect(matchedRect({ w: 50, h: 100 }, { w: 300, h: 100 })).toEqual({ x: 125, y: 0, w: 50, h: 100 });
  });

  it('remembers the choice per file key for the session; an unknown key has none', () => {
    expect(rememberedMatch('diff|a.png')).toBeUndefined();
    rememberMatch('diff|a.png', false);
    expect(rememberedMatch('diff|a.png')).toBe(false);
    rememberMatch('diff|a.png', true);
    expect(rememberedMatch('diff|a.png')).toBe(true);
    expect(rememberedMatch('diff|b.png')).toBeUndefined();
    expect(rememberedMatch(undefined)).toBeUndefined();
  });
});
