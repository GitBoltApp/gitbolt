import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'image.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('image.css motion (J19)', () => {
  it('the image toolbar segmented/toggle buttons fade colour fast and pressed background at the base token', () => {
    expect(rule('.image-toolbar .segmented > button, .image-toolbar .toggle')).toMatch(/transition:\s*color var\(--motion-fast\), background-color var\(--motion-base\)/);
  });

  it('never transitions the image frame/layer (transform-origin, box-shadow bounds — no layout/canvas motion)', () => {
    expect(rule('.image-frame')).not.toMatch(/transition/);
    expect(rule('.image-layer')).not.toMatch(/transition/);
  });

  it('never uses transition: all', () => {
    expect(css).not.toMatch(/transition:\s*all/);
  });
});

describe('image.css toolbar', () => {
  it('never wraps: its items keep their size and the size info truncates first', () => {
    expect(rule('.image-toolbar')).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule('.image-toolbar > *')).toMatch(/flex-shrink:\s*0/);
    const meta = rule('.image-toolbar > .image-meta');
    expect(meta).toMatch(/flex-shrink:\s*1/);
    expect(meta).toMatch(/min-width:\s*0/);
    expect(meta).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe('image.css labels (K9)', () => {
  it("the Old/New (and Amplify) chips never block a drag or the swipe handle", () => {
    expect(rule('.image-label')).toMatch(/pointer-events:\s*none/);
  });
});

describe('image.css side-by-side divider (K21)', () => {
  it('draws a 1 px line, off the existing border token, centred in the stage', () => {
    const r = rule('.side-divider');
    expect(r).toMatch(/width:\s*1px/);
    expect(r).toMatch(/background:\s*var\(--section-border\)/);
    expect(r).toMatch(/left:\s*50%/);
  });

  it('is out of flow (absolute), so it never nudges the flexed viewports’ widths by even a sub-pixel', () => {
    expect(rule('.side-divider')).toMatch(/position:\s*absolute/);
    expect(rule('.image-stage')).toMatch(/position:\s*relative/);
  });

  it("never blocks a drag on the image beneath it", () => {
    expect(rule('.side-divider')).toMatch(/pointer-events:\s*none/);
  });
});

describe('image.css side-by-side labels (K22)', () => {
  it('are bigger and centred horizontally, near the top, in side-by-side only', () => {
    const r = rule('.image-stage.mode-side .image-viewport > .image-label');
    expect(r).toMatch(/left:\s*50%/);
    expect(r).toMatch(/transform:\s*translateX\(-50%\)/);
    expect(r).toMatch(/top:\s*8px/);
    expect(r).toMatch(/font-size:\s*13px/);
  });

  it('leaves swipe corner chips (label-bl/label-br) unchanged', () => {
    expect(rule('.image-viewport > .image-label.label-bl')).toMatch(/left:\s*6px/);
    expect(rule('.image-viewport > .image-label.label-br')).toMatch(/right:\s*6px/);
  });
});

describe('image.css fixed-width slider values (K23)', () => {
  it("the Amplify value reserves space for its widest reading (16×), tabular digits", () => {
    const r = rule('.amplify-value');
    expect(r).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(r).toMatch(/min-width:\s*3ch/);
  });

  it('the zoom % value reserves space for its widest reading (1000%), tabular digits', () => {
    const r = rule('.image-toolbar .zoom-value');
    expect(r).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(r).toMatch(/min-width:\s*5ch/);
  });
});
