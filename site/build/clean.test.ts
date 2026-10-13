import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { emptyExceptDemo } from './clean.ts';

test('the page build empties dist/ but keeps the demo the demo build wrote', () => {
  const dist = mkdtempSync(join(tmpdir(), 'site-dist-'));
  mkdirSync(join(dist, 'demo', 'assets'), { recursive: true });
  writeFileSync(join(dist, 'demo', 'demo.html'), 'demo');
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'old.js'), 'old');
  writeFileSync(join(dist, 'index.html'), 'old');
  emptyExceptDemo(dist);
  expect(existsSync(join(dist, 'demo', 'demo.html'))).toBe(true);
  expect(existsSync(join(dist, 'assets'))).toBe(false);
  expect(existsSync(join(dist, 'index.html'))).toBe(false);
});

test('a missing dist/ is fine', () => {
  expect(() => emptyExceptDemo(join(tmpdir(), 'no-such-site-dist'))).not.toThrow();
});
