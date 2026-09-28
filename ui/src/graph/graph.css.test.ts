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

  it('dims the DOM connector like the canvas part: lane colour at 25% (F8, draw.ts CONNECTOR_ALPHA)', () => {
    const connectorRule = css.match(/\.ref-connector\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(connectorRule).toMatch(/background:\s*var\(--lane-color\)/);
    expect(connectorRule).toMatch(/opacity:\s*0?\.25\b/);
  });

  it('keeps the connector at a minimum visible width instead of letting it be squeezed to 0', () => {
    const connectorRule = css.match(/\.ref-connector\s*\{([^}]*)\}/)?.[1] ?? '';
    // flex-shrink 0 (via the `flex` shorthand's middle value) with a non-zero basis: it can
    // still grow to fill leftover space, but never gives any of its own basis back up.
    expect(connectorRule).toMatch(/flex:\s*1\s+0\s+\d/);
  });
});

describe('graph.css message cell', () => {
  it('separates the summary from the dimmed body with a ~10px margin, not a text space', () => {
    const bodyRule = css.match(/\.msg-body\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(bodyRule).toMatch(/margin-left:\s*10px/);
  });
});

describe('graph.css SHA button', () => {
  it('restores a visible keyboard focus ring after `all: unset` removed the default one', () => {
    expect(css).toMatch(/\.sha\s*\{[^}]*all:\s*unset/);
    const rule = css.match(/\.sha:focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/outline:\s*\d+px\s+solid\s+\S+/);
    expect(rule).not.toMatch(/outline:\s*(none|0)\b/);
  });
});

describe('graph.css canvas clip', () => {
  it('clips the canvas wrapper so the canvas never paints outside the scroll viewport', () => {
    const rule = css.match(/\.graph-canvas-clip\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/pointer-events:\s*none/);
  });
});

describe('graph.css hover-expanded label chip', () => {
  const rule = css.match(/\.ref-label\.ref-label-full\s*\{([^}]*)\}/)?.[1] ?? '';

  it('floats out of flow, above the canvas, so the row and connector geometry never move', () => {
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/z-index:\s*[1-9]/);
  });

  it('takes the pointer, so the chip stays expanded over its revealed part (icons and their tooltips reachable, F4)', () => {
    // It's a DOM child of the chip: hovering it is still hovering the chip.
    expect(rule).not.toMatch(/pointer-events:\s*none/);
  });

  it('is kept inside the graph body\'s own stacking context (never above toasts or other panels)', () => {
    const body = css.match(/\.graph-body\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toMatch(/isolation:\s*isolate/);
  });

  it('is not width-capped or truncated', () => {
    expect(rule).toMatch(/max-width:\s*none/);
    expect(css).not.toMatch(/\.ref-name-full\s*\{[^}]*(text-overflow|overflow:\s*hidden)/);
  });

  it('keeps the rows free of transforms (a stacking context would trap the chip under the canvas)', () => {
    const rowRule = css.match(/\.graph-row\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rowRule).not.toMatch(/transform|z-index|isolation|will-change/);
  });
});

describe('graph.css pointer cursors (F5)', () => {
  const rule = (sel: string) => css.match(new RegExp(`(?:^|\\}|,)\\s*${sel.replace(/[.[\]()>*+?^$|]/g, (c) => `\\${c}`)}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'm'))?.[1] ?? '';

  it('rows (and so the graph nodes and every row cell) are clickable: pointer', () => {
    expect(rule('.graph-row')).toMatch(/cursor:\s*pointer/);
  });

  it('the Branch/Tag cell\'s empty space is not clickable (F6): default cursor; its chips are', () => {
    expect(rule('.graph-row > .col-labels')).toMatch(/cursor:\s*default/);
    // The whole cell, above and below the chip too, not just the chip's 17 px band.
    expect(rule('.graph-row > .col-labels')).toMatch(/align-self:\s*stretch/);
    expect(rule('.ref-label')).toMatch(/cursor:\s*pointer/);
    expect(rule('.ref-more')).toMatch(/cursor:\s*pointer/);
  });

  it('SHA buttons use pointer and resizers keep col-resize', () => {
    expect(rule('.sha')).toMatch(/cursor:\s*pointer/);
    expect(rule('.col-resizer')).toMatch(/cursor:\s*col-resize/);
  });
});

describe('graph.css branch membership chip (F7)', () => {
  const rule = css.match(/\.ref-label\.ref-label-dim\s*\{([^}]*)\}/)?.[1] ?? '';

  it('is the chip look at half opacity (0.5)', () => {
    expect(rule).toMatch(/opacity:\s*0?\.5\b/);
  });

  it('is inert: never takes the pointer', () => {
    expect(rule).toMatch(/pointer-events:\s*none/);
  });
});

describe('graph.css dimmed row text (F10)', () => {
  const colorOf = (sel: string) => css.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/[.[\]()>]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`, 'm'))?.[1].match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1].trim();

  it('author, date and SHA use the same single token as the rest of the commit message', () => {
    const token = colorOf('.dim');
    expect(token).toBe('var(--text-disabled)');
    expect(colorOf('.col-author')).toBe(token);
    expect(colorOf('.col-date')).toBe(token);
    expect(colorOf('.col-sha .sha')).toBe(token);
  });

  it('only the graph\'s SHAs: the shared .sha button (the details panel\'s parent links) keeps its colour', () => {
    expect(colorOf('.sha')).toBe('var(--text-secondary)');
    // The graph rule comes before .sha:hover / :focus-visible, so those still win on hover/focus.
    expect(css.search(/^\.col-sha \.sha\s*\{/m)).toBeGreaterThan(-1);
    expect(css.search(/^\.col-sha \.sha\s*\{/m)).toBeLessThan(css.search(/^\.sha:hover\s*\{/m));
  });
});

describe('graph.css membership chip after real chips (F7)', () => {
  const slot = css.match(/\.ref-dim-slot\s*\{([^}]*)\}/)?.[1] ?? '';

  it('gives up its space before the real chip does (a huge flex-shrink), down to nothing', () => {
    expect(slot).toMatch(/flex:\s*0\s+\d{5,}\s+auto/);
    expect(slot).toMatch(/min-width:\s*0/);
  });

  it('drops the chip instead of truncating it: a one-line wrapping box that hides the wrapped line', () => {
    expect(slot).toMatch(/flex-wrap:\s*wrap/);
    expect(slot).toMatch(/overflow:\s*hidden/);
    expect(slot).toMatch(/height:\s*var\(--graph-chip-h\)/);
    const chip = css.match(/\.ref-dim-slot\s*>\s*\.ref-label-dim\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(chip).toMatch(/flex:\s*none/);
  });

  it('draws the connector line through the space it leaves (same 25% lane colour as .ref-connector)', () => {
    const fill = css.match(/\.ref-dim-fill\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(fill).toMatch(/flex:\s*1\s+0\s+0/);
    expect(fill).toMatch(/color-mix\(in srgb,\s*var\(--lane-color\)\s*25%,\s*transparent\)/);
  });
});

describe('graph.css message tooltip cut (F1)', () => {
  it('hides the overflow (no dead scrollbar: it never takes the pointer) and fades out a clipped message', () => {
    expect(css.match(/\.hover-tooltip\.msg-tooltip\s*\{([^}]*)\}/)?.[1]).toMatch(/overflow:\s*hidden/);
    const fade = css.match(/\.hover-tooltip\.msg-tooltip\[data-clipped\]::after\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(fade).toMatch(/linear-gradient\(/);
    expect(fade).toMatch(/position:\s*absolute/);
    expect(fade).toMatch(/bottom:\s*0/);
  });
});

describe('graph.css density (H1)', () => {
  const body = (sel: string) => css.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/[.[\]()>*+?^$|]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';

  it('header and row cells pad by the density\'s --graph-cell-pad-x', () => {
    expect(body('.graph-row > span')).toMatch(/padding:\s*0 var\(--graph-cell-pad-x\)/);
    expect(body('.graph-header-inner > span')).toMatch(/padding:\s*0 var\(--graph-cell-pad-x\)/);
  });

  it('SHA keeps its fixed 6 px padding, which its width limits assume (columns.ts SHA_PAD)', () => {
    expect(css).toMatch(/\.graph-row > \.col-sha,\s*\.graph-header-inner > \[data-col="sha"\]\s*\{[^}]*padding:\s*0 6px/);
  });

  it('chips, and the membership slot that holds one, are --graph-chip-h tall', () => {
    expect(body('.ref-label')).toMatch(/height:\s*var\(--graph-chip-h\)/);
    expect(body('.ref-dim-fill')).toMatch(/height:\s*var\(--graph-chip-h\)/);
  });
});

/** A rule's body by its exact selector text (a selector list included). */
const ruleBody = (sel: string) => css.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/[.[\]()>*+?^$|]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';

describe('graph.css chips at rest (H3)', () => {
  it('rest subdued: lane colour at 25% (--graph-color-N-bg25), normal text', () => {
    const chip = ruleBody('.ref-label');
    expect(chip).toMatch(/--chip-mix:\s*25%/);
    expect(chip).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--lane-color\)\s*var\(--chip-mix\),\s*transparent\)/);
    expect(chip).toMatch(/color:\s*var\(--text-normal\)/);
  });

  it('light up to 45% and white text while their row is hovered or selected', () => {
    const lit = ruleBody('.graph-row:hover .ref-label, .graph-row[aria-selected="true"] .ref-label');
    expect(lit).toMatch(/--chip-mix:\s*45%/);
    expect(lit).toMatch(/color:\s*var\(--text-selected\)/);
  });
});

describe('graph.css selected and hovered rows (H14)', () => {
  const TEXT = ':is([data-col="message"], [data-col="author"], [data-col="date"], [data-col="sha"])';

  it('the row itself gets no background: the chip and graph columns never turn blue', () => {
    expect(ruleBody('.graph-row:hover')).toBe('');
    expect(ruleBody('.graph-row[aria-selected="true"]')).not.toMatch(/background/);
  });

  it('only the text columns (message, author, date, SHA) do, over the full row height', () => {
    expect(ruleBody(`.graph-row:hover > ${TEXT}`)).toMatch(/background:\s*var\(--hover-row\)/);
    expect(ruleBody(`.graph-row[aria-selected="true"] > ${TEXT}`)).toMatch(/background:\s*var\(--selected-row\)/);
    const cells = ruleBody(`.graph-row > ${TEXT}`);
    expect(cells).toMatch(/align-self:\s*stretch/);
    expect(cells).toMatch(/line-height:\s*var\(--graph-row-h\)/);
  });

  it('no per-panel focus visuals (H4, the user\'s call: keyboard focus is the app\'s as a whole): nothing is styled by the focus zone', () => {
    expect(css).not.toMatch(/data-zone-focused|data-focus-zone/);
  });

  it('author, date and SHA brighten on the selected row (the SHA\'s own hover/focus still wins)', () => {
    const lit = ruleBody('.graph-row[aria-selected="true"] > .col-author, .graph-row[aria-selected="true"] > .col-date, .graph-row[aria-selected="true"] > .col-sha .sha:not(:hover, :focus-visible)');
    expect(lit).toMatch(/color:\s*var\(--text-normal\)/);
  });
});
