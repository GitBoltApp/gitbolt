import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { pendingMethods } from './pending.ts';

test("the demo's pending methods, from coverage.ts's PENDING list", () => {
  const ts = "export const PENDING = [\n  'forgeImage', 'stage',\n  'commit',\n] as const satisfies readonly Method[];";
  expect([...pendingMethods(ts)]).toEqual(['forgeImage', 'stage', 'commit']);
});

test('no PENDING list any more: nothing pending', () => {
  expect(pendingMethods('export const COVERAGE = {} as const;').size).toBe(0);
});

test('the real coverage.ts parses', () => {
  const ts = readFileSync(new URL('../../ui/src/demo/coverage.ts', import.meta.url), 'utf8');
  for (const m of pendingMethods(ts)) expect(m).toMatch(/^[a-z][A-Za-z]+$/);
});
