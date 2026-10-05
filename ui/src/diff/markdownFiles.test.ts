import { describe, expect, it } from 'vitest';
import { isMarkdownPath, overRenderLimit, RENDER_MAX_BYTES } from './markdownFiles';

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
