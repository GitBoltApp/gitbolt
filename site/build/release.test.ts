import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { checkRelease, renderDownloads, type Download, type ReleaseFile } from './release.ts';

const REL = 'https://github.com/GitVoltApp/gitvolt/releases';
const dl = (os: Download['os'], kind: Download['kind'], arch: Download['arch'], file: string, n: number): Download => ({
  os, kind, arch, file, url: `${REL}/download/v1.2.3/${file}`, bytes: 1000 + n, sha256: String(n).repeat(64),
});
const FULL: Download[] = [
  dl('linux', 'deb', 'x86_64', 'GitVolt_1.2.3_amd64.deb', 1),
  dl('linux', 'rpm', 'x86_64', 'GitVolt-1.2.3-1.x86_64.rpm', 2),
  dl('linux', 'arch', 'x86_64', 'GitVolt-1.2.3-1-x86_64.pkg.tar.zst', 3),
  dl('macos', 'dmg', 'aarch64', 'GitVolt_1.2.3_aarch64.dmg', 4),
  dl('windows', 'nsis', 'x86_64', 'GitVolt_1.2.3_x64-setup.exe', 5),
  dl('windows', 'msi', 'x86_64', 'GitVolt_1.2.3_x64.msi', 6),
];
const file = (downloads = FULL, over: Partial<NonNullable<ReleaseFile['release']>> = {}): ReleaseFile => ({
  schema: 1,
  release: { version: '1.2.3', tag: 'v1.2.3', prerelease: false, published: '2026-09-01T12:00:00Z', url: `${REL}/tag/v1.2.3`, sums: `${REL}/download/v1.2.3/SHA256SUMS`, downloads, ...over },
});
const buttons = (html: string) => [...html.matchAll(/<a class="fbtn( primary)?" href="([^"]+)">/g)].map((m) => [m[2].split('/').pop(), Boolean(m[1])]);
const card = (html: string, os: string) => {
  const start = html.indexOf(`data-os="${os}"`);
  const end = html.indexOf('data-os="', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
};

test('the cards: Linux, macOS, Windows, each file of the platform, the first one primary', () => {
  const html = renderDownloads(file());
  expect([...html.matchAll(/data-os="(\w+)"/g)].map((m) => m[1])).toEqual(['linux', 'macos', 'windows']);
  expect(buttons(html)).toEqual([
    ['GitVolt_1.2.3_amd64.deb', true], ['GitVolt-1.2.3-1.x86_64.rpm', false], ['GitVolt-1.2.3-1-x86_64.pkg.tar.zst', false],
    ['GitVolt_1.2.3_aarch64.dmg', true],
    ['GitVolt_1.2.3_x64-setup.exe', true], ['GitVolt_1.2.3_x64.msi', false],
  ]);
  expect(html).toContain('<b>Fedora 40+, openSUSE</b>');
  expect(html).toContain('<p>12 or later, Apple Silicon</p>');
  expect(html).toContain('Ad-hoc signed, not notarized');
  expect(html).toContain(`<code>${'4'.repeat(64)}  GitVolt_1.2.3_aarch64.dmg</code>`);
  expect(html).toContain(`Version 1.2.3. Needs Git 2.40 or newer on your <code>PATH</code>. <a href="${REL}/download/v1.2.3/SHA256SUMS"><code>SHA256SUMS</code></a> lists each file's checksum.`);
  expect(html.match(/<span class="youtag" hidden>Your system<\/span>/g)).toHaveLength(3);
});

test('a release without a .dmg: macOS says so and links the release page, no dead button', () => {
  const html = renderDownloads(file(FULL.filter((d) => d.kind !== 'dmg')));
  const mac = card(html, 'macos');
  expect(mac).not.toContain('class="fbtn');
  expect(mac).toContain(`Not in this release: see <a href="${REL}/tag/v1.2.3">the release page</a>.`);
  expect(mac).not.toContain('<details');
});

test('an Intel .dmg, if a release ever has one, comes after Apple Silicon\'s, named as such', () => {
  const html = renderDownloads(file([...FULL.slice(0, 4), dl('macos', 'dmg', 'x86_64', 'GitVolt_1.2.3_x64.dmg', 7), ...FULL.slice(4)]));
  expect(buttons(card(html, 'macos'))).toEqual([['GitVolt_1.2.3_aarch64.dmg', true], ['GitVolt_1.2.3_x64.dmg', false]]);
  expect(html).toContain('<b>Disk image, Intel</b>');
  expect(html).toContain('<p>12 or later</p>');
});

test('a pre-release (offered only while there is no full release) says so', () => {
  const html = renderDownloads(file(FULL, { version: '1.3.0-rc.1', tag: 'v1.3.0-rc.1', prerelease: true }));
  expect(html).toContain('Version 1.3.0-rc.1, a pre-release.');
  expect(renderDownloads(file())).not.toContain('pre-release');
});

test('no release yet: one line to the releases page, no cards', () => {
  const html = renderDownloads({ schema: 1, release: null });
  expect(html).toBe(`<p class="dfoot">No release yet: see <a href="${REL}">the releases page</a>.</p>`);
});

test('release.json is checked: schema 1, GitHub release URLs of this project, real checksums', () => {
  const ok = file();
  expect(checkRelease(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
  expect(checkRelease({ schema: 1, release: null })).toEqual({ schema: 1, release: null });
  expect(() => checkRelease({ schema: 2, release: null })).toThrow(/schema/);
  expect(() => checkRelease(file([{ ...FULL[0], url: 'https://example.com/x.deb' }]))).toThrow(/not a download of v1\.2\.3/);
  expect(() => checkRelease(file([{ ...FULL[0], sha256: 'abc' }]))).toThrow(/sha256/);
  expect(() => checkRelease(file([{ ...FULL[0], os: 'beos' as Download['os'] }]))).toThrow(/os/);
  expect(() => checkRelease(file(FULL, { version: 'latest' }))).toThrow(/version/);
});

test('the committed release.json is valid and has a file for every platform', () => {
  const r = checkRelease(JSON.parse(readFileSync(new URL('../data/release.json', import.meta.url), 'utf8')));
  expect(r.release).not.toBeNull();
  expect(renderDownloads(r)).not.toContain('Not in this release');
});
