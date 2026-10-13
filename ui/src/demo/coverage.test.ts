import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { DemoContext } from './context';
import { COVERAGE, PENDING } from './coverage';
import { NOT_IN_DEMO } from './engine/errors';
import { HANDLERS, isPending } from './handlers';
import type { Method } from './transport';

const requestTs = readFileSync(new URL('../api/gen/Request.ts', import.meta.url), 'utf8');
const methods = [...requestTs.matchAll(/"method": "(\w+)"/g)].map((m) => m[1] as Method);
const call = (m: Method) => (HANDLERS[m] as (p: unknown, c: DemoContext) => Promise<unknown>)(undefined, {} as DemoContext);

test('a tier and a handler for exactly the backend methods', () => {
  expect(methods.length).toBeGreaterThan(150);
  expect(Object.keys(COVERAGE).sort()).toEqual([...methods].sort());
  expect(Object.keys(HANDLERS).sort()).toEqual([...methods].sort());
});

test('each "Not in the demo" method says so, in words, without touching anything', async () => {
  for (const m of methods.filter((x) => COVERAGE[x] === 'notInDemo')) {
    expect(isPending(HANDLERS[m]), m).toBe(false);
    const err = await call(m).then(() => null, (e: unknown) => e as { kind: string; message: string });
    expect(err?.kind, m).toBe('Other');
    expect(err?.message, m).toMatch(new RegExp(`^${NOT_IN_DEMO}\\S`));
    expect(err?.message, m).not.toBe(`${NOT_IN_DEMO}${m}`);
  }
});

test('the methods still to do are exactly the real and canned ones without a handler', () => {
  expect(new Set(methods.filter((m) => isPending(HANDLERS[m])))).toEqual(new Set(PENDING));
  for (const m of PENDING) expect(COVERAGE[m], m).not.toBe('notInDemo');
});
