import { describe, expect, it } from 'vitest';
import { diffRenderKey, isMarkdownPath, overRenderLimit, RENDER_MAX_BYTES } from './markdownFiles';

describe('isMarkdownPath (spec #5 §3.3)', () => {
  it.each([
    ['README.md', true], ['docs/Guide.MD', true], ['notes.markdown', true], ['page.mdx', true],
    ['a.txt', false], ['md', false], ['.md', false], ['docs.md/file.txt', false], ['x.mdown', false],
  ])('%s → %s', (path, want) => expect(isMarkdownPath(path)).toBe(want));
});

describe('overRenderLimit (spec #5 §3.1)', () => {
  it('counts UTF-8 bytes against 5 MB', () => {
    expect(overRenderLimit('a'.repeat(RENDER_MAX_BYTES))).toBe(false);
    expect(overRenderLimit('a'.repeat(RENDER_MAX_BYTES + 1))).toBe(true);
    expect(overRenderLimit('é'.repeat(RENDER_MAX_BYTES / 2 + 1))).toBe(true);
  });
});

describe('diffRenderKey (5C, R14)', () => {
  it('is keyed by content: an edit that keeps the length is a new key, so the budget is checked again', () => {
    expect(diffRenderKey('k', '# Old\n', 'Run it once.\n')).toBe(diffRenderKey('k', '# Old\n', 'Run it once.\n'));
    expect(diffRenderKey('k', '# Old\n', 'Run it once.\n')).not.toBe(diffRenderKey('k', '# Old\n', 'Run it ONCE.\n'));
    expect(diffRenderKey('k', '# Old\n', 'x')).not.toBe(diffRenderKey('j', '# Old\n', 'x'));
  });
});
