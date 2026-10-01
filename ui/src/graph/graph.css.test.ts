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
    // Only a top margin: its line's place in the row (K57).
    expect(connectorRule.replace(/margin-top:[^;]*;/, '')).not.toMatch(/margin/);
  });

  it('places the connector at the row\'s line (K57): stretched labels, the top and height from --conn-top / --conn-h', () => {
    const connectorRule = css.match(/\.ref-connector\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(connectorRule).toMatch(/align-self:\s*flex-start/);
    expect(connectorRule).toMatch(/margin-top:\s*var\(--conn-top\)/);
    expect(connectorRule).toMatch(/height:\s*var\(--conn-h\)/);
    const labels = css.match(/\.ref-labels\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(labels).toMatch(/align-self:\s*stretch/);
    expect(labels).toMatch(/--conn-h:\s*1px/);
  });

  it('lets the ref chip shrink (and ellipsize) instead of overflowing the label column', () => {
    const refLabelRule = css.match(/\.ref-label\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(refLabelRule).toMatch(/min-width:\s*0/);
    // No cap of its own (K63): only the column's width truncates it.
    expect(refLabelRule).not.toMatch(/max-width/);
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

describe("graph.css checked-out branch (J21)", () => {
  const rule = (sel: RegExp) => css.match(new RegExp(`${sel.source}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  it('its chip is always lit: the hovered/selected look, with no row condition', () => {
    const r = rule(/\n\.ref-label\.ref-label-head/);
    expect(r).toMatch(/--chip-mix:\s*45%/);
    expect(r).toMatch(/color:\s*var\(--text-selected\)/);
  });
  it('its check is ~1.4x the 12 px icons (17 px at the standard 22 px chip), scaling with the density', () => {
    const r = rule(/\.ref-head-check/);
    const k = Number(/var\(--graph-chip-h\)\s*\*\s*([\d.]+)/.exec(r)?.[1]);
    expect(Math.round(22 * k)).toBe(17);
    expect(r).toMatch(/width:/);
    expect(r).toMatch(/height:/);
  });
  it('its connector is the graph line: 2 px, the full lane colour', () => {
    expect(rule(/\.ref-labels-head/)).toMatch(/--conn-h:\s*2px/);
    const r = rule(/\.ref-labels-head\s*>\s*\.ref-connector/);
    expect(r).toMatch(/opacity:\s*1\b/);
    const fill = rule(/\.ref-labels-head\s+\.ref-dim-fill::before/);
    expect(fill).toMatch(/background:\s*var\(--lane-color\)/);
    expect(fill).not.toMatch(/25%/);
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

  it('takes the pointer like the other chips (J6): hover, expansion and the pointer cursor', () => {
    expect(rule).not.toMatch(/pointer-events|cursor/);
  });

  it('hovered, it brightens to the hovered chip look: full strength (J6)', () => {
    expect(css).toMatch(/(?:^|\})\s*\.ref-label\.ref-label-dim:hover\s*\{[^}]*opacity:\s*1\b/m);
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
    // The line itself, on the connector's rows (K57).
    const line = css.match(/\.ref-dim-fill::before\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(line).toMatch(/color-mix\(in srgb,\s*var\(--lane-color\)\s*25%,\s*transparent\)/);
    expect(line).toMatch(/top:\s*calc\(var\(--conn-top\)/);
    expect(line).toMatch(/height:\s*var\(--conn-h\)/);
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

describe('graph.css text selection (J20)', () => {
  it('the whole graph panel (headers, rows, cells, chips, resizers) never selects text', () => {
    const panel = ruleBody('.graph-panel');
    expect(panel).toMatch(/(?:^|;)\s*user-select:\s*none/);
    expect(panel).toMatch(/-webkit-user-select:\s*none/);
    // Nothing inside turns it back on.
    expect(css.match(/user-select:\s*(?!none)\w+/g)).toBeNull();
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

  it('author, date and SHA light up to the selected row\'s own white, like its summary (J7)', () => {
    const lit = ruleBody('.graph-row[aria-selected="true"] > .col-author, .graph-row[aria-selected="true"] > .col-date, .graph-row[aria-selected="true"] > .col-sha .sha');
    expect(lit).toMatch(/color:\s*var\(--text-selected\)/);
    expect(ruleBody('.graph-row[aria-selected="true"]')).toMatch(/color:\s*var\(--text-selected\)/);
  });
});

describe('graph.css row text: the row-dim mechanism and its motion (J22)', () => {
  const tokens = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../theme/tokens.css'), 'utf8');
  const TEXT = ':is([data-col="message"], [data-col="author"], [data-col="date"], [data-col="sha"])';
  const PARTS = ':is(.dim, .sha, .wip-tag, .wip-counts)';

  it('the text cells, and their own-coloured parts, ease their colour: 200 ms ease-in (the selection moving)', () => {
    expect(ruleBody(`.graph-row > ${TEXT}, .graph-row > [data-col] ${PARTS}`)).toMatch(/^\s*transition:\s*color var\(--motion-row-color\) ease-in;?\s*$/);
  });

  it('dimmed: every level eases in over 500 ms ease-out, no delay; restoring takes the 200 ms; the base rule carries no colour of its own', () => {
    const dim = ruleBody(`.graph-row > [data-col].row-dim, .graph-row > [data-col].row-dim ${PARTS}`);
    expect(dim).not.toMatch(/color:/);
    expect(dim).toMatch(/^\s*transition:\s*color var\(--motion-row-dim\) ease-out;?\s*$/);
    // It comes after the selected row's white (same specificity for the SHA): a selected row
    // outside the branch dims too.
    expect(css.indexOf('.row-dim')).toBeGreaterThan(css.indexOf('.graph-row[aria-selected="true"] > .col-sha .sha'));
  });

  it("two dim levels (rowDim.ts DimKind), each its own colour: branch-hover (J22) lighter than filter/search", () => {
    const branch = ruleBody(`.graph-row > [data-col].row-dim-branch, .graph-row > [data-col].row-dim-branch ${PARTS}`);
    expect(branch).toMatch(/color:\s*var\(--text-row-dimmed-branch\)/);
    const filter = ruleBody(`.graph-row > [data-col].row-dim-filter, .graph-row > [data-col].row-dim-filter ${PARTS}`);
    expect(filter).toMatch(/color:\s*var\(--text-row-dimmed\)/);
    // The tokens themselves: 50% white for branch-hover, 20% for
    // filter.
    expect(tokens).toMatch(/--text-row-dimmed-branch:\s*rgba\(255,\s*255,\s*255,\s*0\.5\)/);
    expect(tokens).toMatch(/--text-row-dimmed:\s*rgba\(255,\s*255,\s*255,\s*0\.2\)/);
  });

  it('colour only: no transition on backgrounds, the rows\' top or transform, or anything else', () => {
    for (const t of css.match(/transition:[^;}]*/g) ?? []) expect(t).toMatch(/^transition:\s*color /);
  });

  it('the motion tokens: 200 ms and 500 ms, both 0 under prefers-reduced-motion (the one shared chrome+row override, J19)', () => {
    expect(tokens).toMatch(/--motion-row-color:\s*200ms/);
    expect(tokens).toMatch(/--motion-row-dim:\s*500ms/);
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(tokens)?.[1] ?? '';
    expect(reduced).toMatch(/--motion-row-color:\s*0s/);
    expect(reduced).toMatch(/--motion-row-dim:\s*0s/);
  });
});
