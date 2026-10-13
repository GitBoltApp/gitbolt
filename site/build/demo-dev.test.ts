import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { demoFile } from './demo-dev.ts';

test("/demo/ in the dev server: the demo build's files, nothing outside it", () => {
  const root = mkdtempSync(join(tmpdir(), 'site-demo-dev-'));
  const demo = join(root, 'demo');
  mkdirSync(join(demo, 'demo-data'), { recursive: true });
  writeFileSync(join(demo, 'demo.html'), 'x');
  writeFileSync(join(demo, 'demo-data', 'manifest.json'), '{}');
  writeFileSync(join(root, 'secret.txt'), 'no');
  expect(demoFile(demo, '/demo.html?x=1')).toBe(join(demo, 'demo.html'));
  expect(demoFile(demo, '/demo-data/manifest.json')).toBe(join(demo, 'demo-data', 'manifest.json'));
  expect(demoFile(demo, '/../secret.txt')).toBeNull();
  expect(demoFile(demo, '/%2e%2e/secret.txt')).toBeNull();
  expect(demoFile(demo, '/missing.js')).toBeNull();
  expect(demoFile(demo, '/')).toBeNull();
  expect(demoFile(demo, '/%E0%A4%A')).toBeNull();
});
