import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules; details.spec.ts checks
// the rendered result.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'details.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('details.css (feedback H11)', () => {
  it('the header hashes are white and their labels dimmed, in the UI font (J8)', () => {
    expect(rule('.commit-ids .sha')).toMatch(/color:\s*var\(--text-selected\)/);
    const label = rule('.id-label');
    expect(label).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(label).toMatch(/font-family:\s*var\(--font-ui\)/);
  });

  it('J8: label and hash share one line (one baseline), trimmed to the hash\'s cap height and baseline, so the icon centres on the text, not on a line box', () => {
    const parts = rule('.commit-ids > *');
    expect(parts).toMatch(/display:\s*block/);
    expect(parts).toMatch(/font-family:\s*ui-monospace, monospace/);
    expect(parts).toMatch(/text-box:\s*trim-both cap alphabetic/);
    expect(rule('.commit-ids')).toMatch(/align-items:\s*baseline/);
    expect(rule('.commit-ids')).toMatch(/align-content:\s*center/);
    // The icon on that baseline, centred on the cap height: no pixel nudge.
    // Half the badge's size, from the one shared custom property (header.css), not a literal.
    expect(rule('.commit-ids-start > .sig-badge')).toMatch(/vertical-align:\s*calc\(0\.5cap - var\(--sig-badge-size\) \/ 2\)/);
    const header = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'header.css'), 'utf8');
    const badge = header.match(/\n\.sig-badge \{([^}]*)\}/)?.[1] ?? '';
    expect(badge).toMatch(/--sig-badge-size:\s*16px/);
    expect(badge).toMatch(/width:\s*var\(--sig-badge-size\)/);
    expect(badge).toMatch(/height:\s*var\(--sig-badge-size\)/);
    expect(rule('.commit-ids-start')).not.toMatch(/transform/);
  });

  it('the message is a darker, rounded box', () => {
    const box = rule('.commit-message.message-box');
    expect(box).toMatch(/background:\s*var\(--app-bg0\)/);
    expect(box).toMatch(/border-radius:/);
  });
});

describe('details.css header bars (K5, K6)', () => {
  const diff = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'diff', 'diff.css'), 'utf8');
  const diffRule = (selector: string) => diff.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  it('the commit hashes row, the compare bar and the open file\'s header set no height or border of their own: both come from .panel-bar (tokens.css), so the heights are equal', () => {
    for (const [name, body] of [['.commit-ids', rule('.commit-ids')], ['.compare-bar', rule('.compare-bar')], ['.wip-header', rule('.wip-header')], ['.diff-header', diffRule('.diff-header')]]) {
      expect(body, name).not.toBe('');
      expect(body, name).not.toMatch(/(^|;)\s*(min-|max-)?height:/);
      expect(body, name).not.toMatch(/border(-bottom)?:/);
      expect(body, name).not.toMatch(/padding(-top|-bottom)?:\s*[1-9]/);
    }
  });

  it('nothing above the commit bar: the header section has no top padding, and the bar spans the panel\'s width', () => {
    expect(rule('.commit-details')).toMatch(/padding:\s*0 12px 0;/);
    expect(rule('.commit-ids')).toMatch(/margin:\s*0 -12px/);
    expect(rule('.compare-header')).toMatch(/padding:\s*0 12px/);
    expect(rule('.compare-bar')).toMatch(/margin:\s*0 -12px/);
  });
});

describe('details.css motion (J19)', () => {
  it('the split-resizer hover reveal fades its background at the fast token, not its top/height', () => {
    const before = rule('.split-resizer::before');
    expect(before).toMatch(/transition:\s*background-color var\(--motion-fast\)/);
    expect(before).not.toMatch(/transition:[^;]*\btop\b/);
    expect(before).not.toMatch(/transition:[^;]*\bheight\b/);
  });
});
