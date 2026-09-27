import { describe, expect, it } from 'vitest';
import { brighten } from './difference';

describe('difference blend', () => {
  it('brightens small differences and makes every pixel opaque', () => {
    const d = new Uint8ClampedArray([1, 10, 100, 0, 0, 0, 0, 255]);
    brighten(d, 4);
    expect([...d]).toEqual([4, 40, 255, 255, 0, 0, 0, 255]);
  });
});
