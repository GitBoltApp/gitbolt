import { describe, expect, it } from 'vitest';
import { pxPerCharOf } from './chunkHeights';

describe("a rendered diff's learned chunk height", () => {
  it("is the laid-out chunks' real height over their characters", () => {
    expect(pxPerCharOf([{ height: 3000, chars: 8000 }, { height: 1000, chars: 2000 }])).toBe(0.4);
  });

  it('none laid out (or no size yet): nothing learned', () => {
    expect(pxPerCharOf([])).toBeNull();
    expect(pxPerCharOf([{ height: 0, chars: 8000 }, { height: 500, chars: 0 }])).toBeNull();
  });
});
