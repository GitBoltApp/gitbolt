import { beforeEach, describe, expect, it } from 'vitest';
import { useDiffPrefs } from './diffPrefs';
import { clearMarkdownOverride, markdownViewOf, showSourceFor } from './markdownOverride';

describe("a just-created Markdown file's Source", () => {
  beforeEach(() => { useDiffPrefs.getState().set({ markdownView: 'rendered' }); clearMarkdownOverride(); });

  it('shows that one file in Source and leaves the app-wide pick alone', () => {
    showSourceFor('docs/new.md');
    expect(markdownViewOf('docs/new.md')).toBe('source');
    expect(markdownViewOf('docs/other.md')).toBe('rendered');
    expect(useDiffPrefs.getState().prefs.markdownView).toBe('rendered');
  });

  it('ends when cleared (another file shown, or the toggle used)', () => {
    showSourceFor('docs/new.md');
    clearMarkdownOverride();
    expect(markdownViewOf('docs/new.md')).toBe('rendered');
  });
});
