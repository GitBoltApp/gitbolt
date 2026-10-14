// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { renderDownloads } from '../build/release.ts';
import { initDownloads } from './downloads.ts';

const REL = 'https://github.com/GitVoltApp/gitvolt/releases';
const release = {
  schema: 1 as const,
  release: {
    version: '1.2.3', tag: 'v1.2.3', prerelease: false, published: '2026-09-01T12:00:00Z', url: `${REL}/tag/v1.2.3`, sums: `${REL}/download/v1.2.3/SHA256SUMS`,
    downloads: ([['linux', 'deb', 'x86_64', 'GitVolt_1.2.3_amd64.deb'], ['macos', 'dmg', 'aarch64', 'GitVolt_1.2.3_aarch64.dmg'], ['windows', 'nsis', 'x86_64', 'GitVolt_1.2.3_x64-setup.exe']] as const)
      .map(([os, kind, arch, file]) => ({ os, kind, arch, file, url: `${REL}/download/v1.2.3/${file}`, bytes: 1, sha256: '0'.repeat(64) })),
  },
};

beforeEach(() => {
  document.body.innerHTML = `<a class="cta" href="#downloads">Download <small class="cta-os"></small></a><section id="downloads">${renderDownloads(release)}</section>`;
});
const order = () => [...document.querySelectorAll<HTMLElement>('.dl')].map((d) => d.dataset.os);

test("the visitor's platform first, marked as theirs, and named in the header's Download", () => {
  initDownloads(document, 'windows');
  expect(order()).toEqual(['windows', 'linux', 'macos']);
  const card = document.querySelector<HTMLElement>('.dl[data-os="windows"]')!;
  expect(card.classList.contains('you')).toBe(true);
  expect(card.querySelector('.youtag')!.hasAttribute('hidden')).toBe(false);
  expect(document.querySelectorAll('.youtag:not([hidden])')).toHaveLength(1);
  expect(document.querySelector('.cta')!.textContent).toBe('Download for Windows');
});

test('no known platform: the page stays as built', () => {
  initDownloads(document, null);
  expect(order()).toEqual(['linux', 'macos', 'windows']);
  expect(document.querySelectorAll('.dl.you')).toHaveLength(0);
  expect(document.querySelector('.cta-os')!.textContent).toBe('');
});
