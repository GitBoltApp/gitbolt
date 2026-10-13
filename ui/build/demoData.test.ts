import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { addLicenseToIndex, demoDataFiles } from './demoData';

test('serves the manifest and bundles only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-data-'));
  for (const f of ['manifest.json', 'basic.gbdemo', 'requests.json', 'notes.md']) writeFileSync(join(dir, f), '');
  expect(demoDataFiles(dir)).toEqual(['basic.gbdemo', 'manifest.json']);
  expect(demoDataFiles(join(dir, 'missing'))).toEqual([]);
});

test('adds the WebAssembly notices to the licences index, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-lic-'));
  mkdirSync(join(dir, 'licenses'));
  writeFileSync(join(dir, 'licenses', 'index.json'), JSON.stringify({ files: [{ name: 'LICENSE.txt', size: 3 }] }));
  addLicenseToIndex(dir, 'THIRD-PARTY-NOTICES-wasm.txt', 7);
  addLicenseToIndex(dir, 'THIRD-PARTY-NOTICES-wasm.txt', 7);
  expect(JSON.parse(readFileSync(join(dir, 'licenses', 'index.json'), 'utf8'))).toEqual({
    files: [{ name: 'LICENSE.txt', size: 3 }, { name: 'THIRD-PARTY-NOTICES-wasm.txt', size: 7 }],
  });
});
