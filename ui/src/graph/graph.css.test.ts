import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// vitest doesn't process CSS imports by default (`test.css` isn't enabled in vite.config.ts),
// so a component test can't see graph.css's rules via getComputedStyle: importing it in a
// .test.tsx file yields zero <style> tags in jsdom, and every computed style reads as the
// browser default. That means the actual "no gap" contract (the label column's right padding,
// and the connector having no leading gap), and the actual rendered "chip ellipsizes instead
// of pushing the connector off-screen" behavior, can only be verified against rendered layout
// in Task 13's Playwright suite, not here. This test instead pins the CSS source itself, as a
// cheap regression guard against the raw rules regressing.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'graph.css'), 'utf8');

describe('graph.css label-connector contract', () => {
  it('zeroes the label column\'s right padding so it is flush with the canvas edge', () => {
    expect(css).toMatch(/\.graph-row\s*>\s*\.col-labels\s*\{[^}]*padding-right:\s*0/);
  });

  it('does not put a flex gap between the ref chip, the "+N" badge and the connector', () => {
    const refLabelsRule = css.match(/\.ref-labels\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(refLabelsRule).not.toMatch(/gap:/);
  });

  it('gives the connector no leading margin, so it touches the preceding chip/badge', () => {
    const connectorRule = css.match(/\.ref-connector\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(connectorRule).not.toMatch(/margin/);
  });

  it('lets the ref chip shrink (and ellipsize) instead of overflowing the label column', () => {
    const refLabelRule = css.match(/\.ref-label\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(refLabelRule).toMatch(/min-width:\s*0/);
    // `flex: none` (equivalently `flex-shrink: 0`) would defeat min-width: 0 by refusing to
    // shrink at all, so the chip must not fall back to it.
    expect(refLabelRule).not.toMatch(/flex:\s*none/);
    expect(refLabelRule).not.toMatch(/flex-shrink:\s*0/);
  });

  it('keeps the connector at a minimum visible width instead of letting it be squeezed to 0', () => {
    const connectorRule = css.match(/\.ref-connector\s*\{([^}]*)\}/)?.[1] ?? '';
    // flex-shrink 0 (via the `flex` shorthand's middle value) with a non-zero basis: it can
    // still grow to fill leftover space, but never gives any of its own basis back up.
    expect(connectorRule).toMatch(/flex:\s*1\s+0\s+\d/);
  });
});
