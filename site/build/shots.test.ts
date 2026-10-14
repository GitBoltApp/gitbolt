import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { heroMarker, renderShot, renderStill, shotExists, SHOTS } from './shots.ts';

test("the hero is 16:10 at the frame's width; each feature at the column's width, as tall as the part it shows", () => {
  expect(SHOTS.hero).toMatchObject({ width: 1240, height: 775 });
  for (const [id, s] of Object.entries(SHOTS)) {
    if (id === 'hero') continue;
    expect(s.width, id).toBe(720);
    expect(s.height, id).toBeGreaterThanOrEqual(400);
    expect(s.height, id).toBeLessThanOrEqual(720);
  }
  expect(SHOTS.image).toMatchObject({ width: 720, height: 545 });
  expect(SHOTS.review).toMatchObject({ width: 720, height: 400 });
});

test('a taken screenshot is a lazy image with its 1x and 2x files, its size and alt text', () => {
  const html = renderShot('image', true);
  expect(html).toContain('src="./shots/image-1x.webp"');
  expect(html).toContain('srcset="./shots/image-1x.webp 720w, ./shots/image.webp 1440w"');
  expect(html).toContain('width="720" height="545"');
  expect(html).toContain(`alt="${SHOTS.image.alt}"`);
  expect(html).toContain('loading="lazy"');
});

test('one not taken yet is the design\'s glass card with its caption, no <img>', () => {
  const html = renderShot('review', false);
  expect(html).not.toContain('<img');
  expect(html).toContain(`<span class="shot-cap">${SHOTS.review.alt}</span>`);
});

test('the hero still loads first and at once; without one, an empty frame keeps its size', () => {
  expect(renderStill(true)).toMatch(/^<img class="still" src="\.\/shots\/hero-1x\.webp" srcset="\.\/shots\/hero-1x\.webp 1240w, \.\/shots\/hero\.webp 2480w"/);
  expect(renderStill(true)).toContain('fetchpriority="high"');
  expect(renderStill(true)).not.toContain('loading="lazy"');
  expect(renderStill(false)).toBe('<div class="still still-missing" aria-hidden="true"></div>');
});

test('a screenshot exists when both its files do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-shots-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hero.webp'), 'x');
  expect(shotExists(dir, 'hero')).toBe(false);
  writeFileSync(join(dir, 'hero-1x.webp'), 'x');
  expect(shotExists(dir, 'hero')).toBe(true);
  expect(heroMarker(dir)('still')).toContain('<img class="still"');
  expect(() => heroMarker(dir)('other')).toThrow('<!--hero:other-->');
});
