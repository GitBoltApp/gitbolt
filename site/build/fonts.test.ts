import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { acceptedLicenses, FONT_PACKAGES, fontLicenses } from './fonts.ts';

test("about.toml's allow-list, read as the UI build reads it, includes OFL-1.1", () => {
  const list = acceptedLicenses(readFileSync(new URL('../../about.toml', import.meta.url), 'utf8'));
  expect(list).toContain('OFL-1.1');
  expect(list).toContain('MIT');
  expect(list).not.toContain('GPL-3.0');
});

function fakeRoot(license: string): string {
  const root = mkdtempSync(join(tmpdir(), 'site-fonts-'));
  for (const pkg of FONT_PACKAGES) {
    const dir = join(root, 'node_modules', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '9.9.9', license }));
    writeFileSync(join(dir, 'LICENSE'), `Copyright 2026 The ${pkg} Authors\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n`);
  }
  return root;
}

test("every face's license, with its package and version", () => {
  const text = fontLicenses(fakeRoot('OFL-1.1'), ['MIT', 'OFL-1.1']);
  for (const pkg of FONT_PACKAGES) expect(text).toContain(`${pkg} 9.9.9 (OFL-1.1)\n\nCopyright 2026 The ${pkg} Authors`);
});

test('a font under a license outside the allow-list fails the build, naming it', () => {
  expect(() => fontLicenses(fakeRoot('GPL-3.0'), ['MIT', 'OFL-1.1'])).toThrow(/@fontsource\/sora: license GPL-3\.0 isn't in about\.toml's accepted list/);
});

test('the installed font packages are OFL-1.1', () => {
  expect(() => fontLicenses(new URL('..', import.meta.url).pathname, ['OFL-1.1'])).not.toThrow();
});
