import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS: this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'files.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('files.css WIP section headers', () => {
  it('K59 (ux round 3): the change-type counts follow the title; the +/- totals sit on the list\'s tool line, at its far end', () => {
    expect(rule('.wip-section-summary')).not.toMatch(/margin-left/);
    expect(rule('.wip-section-head')).toMatch(/gap:\s*8px/);
    expect(rule('.wip-section-head .file-section-title')).toMatch(/flex:\s*none/);
    expect(rule('.wip-section-head .file-totals')).toBe('');
    expect(rule('.list-tool-line > .file-totals')).toMatch(/margin-left:\s*auto/);
  });

  it('K60: one 1px divider above Staged: the header has the border-top, except under the drag handle (whose line is the divider)', () => {
    expect(rule('.wip-section-head')).toMatch(/border-top:\s*1px solid var\(--section-border\)/);
    expect(rule('.split-resizer + .wip-section > .wip-section-head')).toMatch(/border-top:\s*0/);
    // No other edge adds a line there.
    expect(css).not.toMatch(/\.wip-section(-body)?\s*\{[^}]*border-(bottom|top)/);
  });
});
