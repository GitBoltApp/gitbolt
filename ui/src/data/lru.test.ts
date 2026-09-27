import { describe, expect, it } from 'vitest';
import { Lru } from './lru';

describe('Lru', () => {
  it('evicts the least recently used entry past the entry limit', () => {
    const c = new Lru<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect([c.has('a'), c.has('b'), c.has('c')]).toEqual([true, false, true]);
  });

  it('evicts by total size and keeps a single oversize entry', () => {
    const c = new Lru<string, string>(10, 10, (v) => v.length);
    c.set('a', '12345');
    c.set('b', '12345');
    expect(c.bytes).toBe(10);
    c.set('c', '1');
    expect([c.has('a'), c.bytes]).toEqual([false, 6]);
    c.set('big', 'x'.repeat(50));
    expect([c.has('b'), c.has('c'), c.has('big'), c.size]).toEqual([false, false, true, 1]);
  });

  it('replacing a key replaces its size', () => {
    const c = new Lru<string, string>(10, 100, (v) => v.length);
    c.set('a', 'xx');
    c.set('a', 'xxxx');
    expect([c.size, c.bytes, c.peek('a')]).toEqual([1, 4, 'xxxx']);
  });
});
