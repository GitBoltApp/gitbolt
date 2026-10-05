import { describe, expect, it } from 'vitest';
import { isMarkdownPath } from './markdownFiles';

describe('isMarkdownPath (spec #5 §3.3)', () => {
  it.each([
    ['README.md', true], ['docs/Guide.MD', true], ['notes.markdown', true], ['page.mdx', true],
    ['a.txt', false], ['md', false], ['.md', false], ['docs.md/file.txt', false], ['x.mdown', false],
  ])('%s → %s', (path, want) => expect(isMarkdownPath(path)).toBe(want));
});
