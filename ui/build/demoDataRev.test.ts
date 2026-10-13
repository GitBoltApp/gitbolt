import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { publishedData, shortSha } from './demoDataRev';

/** A data folder with these bundles, and a manifest listing `repos` (the bundles by default). */
function folder(bundles: Record<string, string>, repos = Object.keys(bundles)): string {
  const dir = mkdtempSync(join(tmpdir(), 'demo-rev-'));
  for (const [file, body] of Object.entries(bundles)) writeFileSync(join(dir, file), body);
  const entries = repos.map((file) => ({ name: file.replace('.gbdemo', ''), file, group: null, open: 'tab', digest: 'd', bytes: 1 }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, repos: entries, groups: [] }));
  return dir;
}

test('each bundle gets the rev of its bytes, and the manifest one of its own', () => {
  const p = publishedData(folder({ 'orbital.gbdemo': 'one', 'basic.gbdemo': 'two' }));
  if (!p) throw new Error('expected published data');
  const m = JSON.parse(p.manifest) as { repos: { rev: string; digest: string; bytes: number }[] };
  expect(m.repos.map((r) => r.rev)).toEqual([shortSha('one'), shortSha('two')]);
  expect(m.repos[0]).toMatchObject({ digest: 'd', bytes: 1 }); // the committed fields stay
  expect(p.rev).toBe(shortSha(p.manifest));
  expect(p.rev).toMatch(/^[0-9a-f]{12}$/);
  expect(p.bundles).toEqual(['orbital.gbdemo', 'basic.gbdemo']);
});

test("a changed bundle changes its rev and the manifest's, and only a change does", () => {
  const rev = (body: string) => {
    const p = publishedData(folder({ 'orbital.gbdemo': body }));
    if (!p) throw new Error('expected published data');
    return { manifest: p.rev, bundle: (JSON.parse(p.manifest) as { repos: { rev: string }[] }).repos[0].rev };
  };
  const before = rev('one');
  const after = rev('one!');
  expect(after.bundle).not.toBe(before.bundle);
  expect(after.manifest).not.toBe(before.manifest);
  expect(rev('one')).toEqual(before); // the same bytes, the same revs: a rebuild changes nothing
});

test('no manifest: nothing to publish; a listed bundle that is missing fails the build', () => {
  expect(publishedData(mkdtempSync(join(tmpdir(), 'demo-rev-')))).toBeNull();
  expect(() => publishedData(folder({ 'orbital.gbdemo': 'one' }, ['orbital.gbdemo', 'basic.gbdemo']))).toThrow('basic.gbdemo is in');
});
