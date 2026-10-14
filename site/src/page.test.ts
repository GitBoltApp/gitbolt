import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('no inline styles or scripts: the CSP allows neither', () => {
  expect(html).not.toMatch(/\sstyle=/);
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
});

test('links leave only for this project on GitHub; nothing loads from elsewhere', () => {
  for (const m of html.matchAll(/\bhref="(https?:[^"]+)"/g)) expect(m[1]).toMatch(/^https:\/\/github\.com\/GitVoltApp\/gitvolt(\/|$)/);
  expect(html).not.toMatch(/\bsrc="https?:/);
});

test('every in-page link has its target', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/\bhref="#([^"]+)"/g)) expect(ids, m[1]).toContain(m[1]);
});

test('every image has alt text and a size', () => {
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    expect(m[0]).toMatch(/\balt="/);
    expect(m[0]).toMatch(/\bwidth="\d+"/);
    expect(m[0]).toMatch(/\bheight="\d+"/);
  }
});

test('a skip link before the demo lands on the features', () => {
  const skip = html.indexOf('<a class="skip" href="#features">Skip the live demo</a>');
  expect(skip).toBeGreaterThan(-1);
  expect(skip).toBeLessThan(html.indexOf('class="stage"'));
});

test('every generated part has its marker', () => {
  for (const m of ['readme:highlights', 'readme:groups', 'readme:compare', 'release:version', 'release:downloads', 'hero:still']) expect(html).toContain(`<!--${m}-->`);
});

test('Reset demo carries both its labels, so arming shifts nothing', () => {
  expect(html).toContain('<button type="button" class="btn" data-action="reset"><span class="btn-stack"><span class="when-idle">Reset demo</span><span class="when-armed">Reset and lose your changes</span></span></button>');
});
