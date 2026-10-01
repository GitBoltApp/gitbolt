import { describe, expect, it } from 'vitest';
import { brighten } from './difference';

describe('difference blend', () => {
  it('brightens small differences and makes every pixel opaque', () => {
    const d = new Uint8ClampedArray([1, 10, 100, 0, 0, 0, 0, 255]);
    brighten(d, 4);
    expect([...d]).toEqual([4, 40, 255, 255, 0, 0, 0, 255]);
  });

  // K10 (fix round 1): the Amplify slider's value IS the true multiplier — 1× is the raw
  // difference, and the default (4×) matches the old fixed ×4 brighten's look.
  it('amplify is the true multiplier: 1× is raw, 4× is the old default look, up to 16×', () => {
    const raw = new Uint8ClampedArray([1, 2, 3, 0]);
    const atDefault = new Uint8ClampedArray([1, 2, 3, 0]);
    const atMax = new Uint8ClampedArray([1, 2, 3, 0]);
    brighten(raw, 1);
    brighten(atDefault, 4);
    brighten(atMax, 16);
    expect([...raw]).toEqual([1, 2, 3, 255]);
    expect([...atDefault]).toEqual([4, 8, 12, 255]);
    expect([...atMax]).toEqual([16, 32, 48, 255]);
  });
});
