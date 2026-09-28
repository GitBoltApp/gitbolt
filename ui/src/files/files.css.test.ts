import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules; files.spec.ts checks
// the rendered geometry.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'files.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('files.css (feedback round 2)', () => {
  it('file and folder rows are clickable: a pointer cursor (H5)', () => {
    expect(rule('.file-row')).toMatch(/cursor:\s*pointer/);
  });

  it('a folder\'s change counts follow its name instead of the right edge (H16)', () => {
    expect(rule('.file-row .status-counts')).not.toMatch(/margin-left:\s*auto/);
  });

  it('the whole file panel ignores text selection, except an error to copy (J9)', () => {
    expect(rule('.file-sections')).toMatch(/(^|;)\s*user-select:\s*none/);
    expect(rule('.file-sections')).toMatch(/-webkit-user-select:\s*none/);
    expect(rule('.file-sections [role="alert"]')).toMatch(/(^|;)\s*user-select:\s*text/);
  });

  it('a toolbar button that starts with an icon trims its left padding to the icon\'s ink (H17)', () => {
    expect(rule('.toolbar-button.icon-lead')).toMatch(/padding-left:\s*5px/);
  });
});

describe('files.css motion (J19)', () => {
  it('toolbar/segmented buttons fade hover colour fast and pressed background at the base token', () => {
    const base = rule('.segmented > button, .toolbar-button');
    expect(base).toMatch(/transition:\s*color var\(--motion-fast\), background-color var\(--motion-base\)/);
  });

  it('leaves file rows untransitioned: hover/selected backgrounds stay instant', () => {
    expect(rule('.file-row')).not.toMatch(/transition/);
    expect(rule('.file-row\\[aria-selected="true"\\]')).not.toMatch(/transition/);
  });
});
