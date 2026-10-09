import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see image.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'markdown.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('markdown.css (spec #5 §3.1)', () => {
  it('uses theme tokens only, and never transitions everything', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).not.toMatch(/transition:\s*all/);
  });

  it('scrolls wide code inside its block, never widening the panel', () => {
    expect(rule('.md pre')).toMatch(/overflow-x:\s*auto/);
    expect(rule('.md pre, .md .md-code, .md .md-mermaid, .md details')).toMatch(/max-width:\s*100%/);
    expect(rule('.md')).toMatch(/max-width:\s*100%/);
  });

  it("tints inline code inside a word mark over the code's own opaque ground", () => {
    expect(rule('.md .md-diff-ins code')).toMatch(/background-image:\s*linear-gradient\(var\(--md-diff-ins-text\)/);
    expect(rule('.md .md-diff-del code')).toMatch(/background-image:\s*linear-gradient\(var\(--md-diff-del-text\)/);
  });

  it("a suggestion's -/+ column: a sign per changed line, never selected or copied with the code", () => {
    expect(rule('.md-code-signs .md-code-line::before')).toMatch(/user-select:\s*none/);
    expect(rule('.md-code-signs .md-code-add::before')).toMatch(/content:\s*'\+'/);
    expect(rule('.md-code-signs .md-code-del::before')).toMatch(/content:\s*'-'/);
  });

  it('front matter: compact keys, values that wrap in the rest of the width', () => {
    expect(rule('.md .md-frontmatter th')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.md .md-frontmatter td')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.md table.md-frontmatter')).toMatch(/width:\s*100%/);
  });

  it('fits images to the width and keeps their aspect ratio (no shift when they load)', () => {
    expect(rule('.md-img')).toMatch(/max-width:\s*100%/);
    expect(rule('.md-img')).toMatch(/height:\s*auto/);
  });

  it('puts the Copy button over the block, out of the flow, shown on hover', () => {
    expect(rule('.md-copy')).toMatch(/position:\s*absolute/);
    expect(rule('.md-copy')).toMatch(/opacity:\s*0/);
    expect(rule('.md-code:hover .md-copy, .md-copy:focus-visible')).toMatch(/opacity:\s*1/);
  });

  it('keeps plain text as written, and lets the browser skip off-screen chunks', () => {
    expect(rule('.md-plain')).toMatch(/white-space:\s*pre-wrap/);
    expect(rule('.md-plain-chunk')).toMatch(/content-visibility:\s*auto/);
    expect(rule('.md-chunk')).toMatch(/content-visibility:\s*auto/);
  });

  it('hides the footnotes heading as GitHub does, and styles task lists by structure', () => {
    expect(rule('.md section[data-footnotes] > h2')).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(rule('.md li:has(> input[type="checkbox"])')).toMatch(/list-style:\s*none/);
  });

  it('marks diff blocks in the left margin without shifting the layout, and pairs diagrams (5C)', () => {
    expect(rule('.md-diff-block::before')).toMatch(/position:\s*absolute/);
    expect(rule('.md li[data-diff-mark]::before')).toMatch(/position:\s*absolute/);
    expect(rule('.md .md-diff-del')).toMatch(/line-through/);
    expect(rule('.md-diff-pair')).toMatch(/grid-template-columns:\s*1fr 1fr/);
    expect(rule('.md-code-line')).toMatch(/min-width:\s*100%/);
  });

  it("marks with the rendered diff's own, brighter colours, not the editor's", () => {
    expect(rule('.md .md-diff-ins')).toMatch(/background:\s*var\(--md-diff-ins-text\)/);
    expect(rule('.md .md-diff-del')).toMatch(/background:\s*var\(--md-diff-del-text\)/);
    expect(rule('.md .md-diff-ins')).toMatch(/color:\s*var\(--text-selected\)/);
    expect(rule('.md-code-add')).toMatch(/var\(--md-diff-ins-block\)/);
    expect(rule('.md-code-del')).toMatch(/var\(--md-diff-del-block\)/);
    expect(css).not.toMatch(/--diff-(inserted|removed)-/);
  });

  it("tints an added or removed code block over its own ground; a changed one's line marks span the block", () => {
    const added = rule('.md :is(.md-diff-block.md-diff-added, li.md-diff-added) :is(pre, code:not(pre code)):not(.md-block-slot *)');
    const removed = rule('.md :is(.md-diff-block.md-diff-removed, li.md-diff-removed) :is(pre, code:not(pre code)):not(.md-block-slot *)');
    expect(added).toMatch(/background-image:\s*linear-gradient\(var\(--md-diff-ins-block\), var\(--md-diff-ins-block\)\)/);
    expect(removed).toMatch(/background-image:\s*linear-gradient\(var\(--md-diff-del-block\), var\(--md-diff-del-block\)\)/);
    // The pre's own padding is 10px a side: the line's ground reaches through it.
    expect(rule('.md pre')).toMatch(/padding:\s*8px 10px/);
    expect(rule('.md-code-line')).toMatch(/margin:\s*0 -10px;\s*padding:\s*0 10px/);
  });

  it("sizes File View's and the diff's rendered text like their editor; 12px elsewhere; code scales with it", () => {
    expect(rule('.md')).toMatch(/font-size:\s*var\(--md-font-size, 12px\)/);
    expect(rule('.md pre')).toMatch(/font:\s*0\.92em\/1\.45 var\(--font-mono\)/);
  });

  it("marks a changed code line's changed words with the word colours, over the line's tint", () => {
    expect(rule('.md-code-word-add')).toMatch(/background:\s*var\(--md-diff-ins-text\)/);
    expect(rule('.md-code-word-del')).toMatch(/background:\s*var\(--md-diff-del-text\)/);
    expect(rule('.md-code-word-add')).not.toMatch(/color:/);
  });

  it("draws an item's bar in its list's gutter, left of the marker, at a block bar's x for that level", () => {
    expect(rule('.md ul, .md ol')).toMatch(/padding-left:\s*var\(--md-list-indent\)/);
    expect(rule('.md-diff-block::before')).toMatch(/left:\s*-12px/);
    // The list's indent plus the block bar's 12px; a block directly in an item takes the same x.
    expect(rule('.md li[data-diff-mark]::before, .md li > .md-diff-block::before')).toMatch(/left:\s*calc\(-1 \* var\(--md-list-indent\) - 12px\)/);
    expect(rule('.md li[data-diff-mark]::before')).not.toMatch(/left:/);
  });

  it("review slots (spec 2026-10-08 §3): a pair's spans both columns; one in a changed block or item takes neither its tint nor its bar", () => {
    expect(rule('.md-diff-pair > .md-block-slot')).toMatch(/grid-column:\s*1 \/ -1/);
    const inChange = rule('.md :is(.md-diff-block, li[data-diff-mark]) > .md-block-slot');
    expect(inChange).toMatch(/background:\s*var\(--app-bg0\)/);
    expect(inChange).toMatch(/z-index:\s*1/);
    // Over the bar: left by the bar's offset, its content back in place.
    expect(rule('.md .md-diff-block > .md-block-slot')).toMatch(/margin-left:\s*-12px;\s*padding-left:\s*12px/);
    expect(rule('.md li[data-diff-mark] > .md-block-slot, .md li > .md-diff-block > .md-block-slot')).toMatch(/margin-left:\s*calc\(-1 \* var\(--md-list-indent\) - 12px\)/);
  });
});
