import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';

describe('contrastRatio', () => {
  it('matches WCAG for the extremes', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#1c1e23', '#1c1e23')).toBeCloseTo(1, 5);
  });

  it('composites a translucent foreground over the background', () => {
    // 75% white over Default Dark's background: the spec's "text-normal".
    expect(contrastRatio('rgba(255, 255, 255, 0.75)', '#1c1e23')).toBeCloseTo(9.84, 1);
  });

  it('rejects a translucent background', () => {
    expect(() => contrastRatio('#fff000', 'rgba(0,0,0,0.5)')).toThrow(/opaque/);
  });
});
