import { describe, expect, it } from 'vitest';
import { OVERFLOW_LAYER_CLASS, OVERFLOW_LAYER_Z, overflowLayer } from './overflow';

describe('the overflow layer (G.1)', () => {
  it('is one fixed, themed box on <body>, made again if something removed it', () => {
    const a = overflowLayer();
    expect(a.parentElement).toBe(document.body);
    expect(a.classList.contains('monaco-editor') && a.classList.contains(OVERFLOW_LAYER_CLASS)).toBe(true);
    expect([a.style.position, a.style.top, a.style.left, a.style.zIndex]).toEqual(['fixed', '0px', '0px', String(OVERFLOW_LAYER_Z)]);
    expect(overflowLayer()).toBe(a);
    a.remove();
    const b = overflowLayer();
    expect(b).not.toBe(a);
    expect(b.isConnected).toBe(true);
  });
});
