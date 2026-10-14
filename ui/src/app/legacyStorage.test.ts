import { expect, test } from 'vitest';
import { adoptLegacyKeys } from './legacyStorage';

/** A Storage over a Map, so the test doesn't depend on the environment's. */
function memory(entries: Record<string, string>): Storage & { all(): Record<string, string> } {
  const m = new Map(Object.entries(entries));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    all: () => Object.fromEntries(m),
  };
}

test("GitBolt's keys take GitVolt's names; others stay", () => {
  const s = memory({ 'gitbolt.theme.v1': 'nord', 'gitbolt.wipDraft.v2': '{"x":1}', 'other': 'keep' });
  expect(adoptLegacyKeys(s)).toBe(2);
  expect(s.all()).toEqual({ 'gitvolt.theme.v1': 'nord', 'gitvolt.wipDraft.v2': '{"x":1}', 'other': 'keep' });
});

test("a value GitVolt already has wins, and GitBolt's goes", () => {
  const s = memory({ 'gitbolt.zoom.v1': '3', 'gitvolt.zoom.v1': '5' });
  expect(adoptLegacyKeys(s)).toBe(0);
  expect(s.all()).toEqual({ 'gitvolt.zoom.v1': '5' });
});

test('a second run moves nothing', () => {
  const s = memory({ 'gitbolt.density.v1': 'compact' });
  adoptLegacyKeys(s);
  expect(adoptLegacyKeys(s)).toBe(0);
  expect(s.all()).toEqual({ 'gitvolt.density.v1': 'compact' });
});
