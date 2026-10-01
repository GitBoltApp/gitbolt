import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import php from 'shiki/langs/php.mjs';
import { describe, expect, it } from 'vitest';
import { darcula } from './darcula';

describe('darcula Shiki theme', () => {
  it('highlights PHP with JetBrains Darcula colors', async () => {
    const hl = await createHighlighterCore({ themes: [darcula], langs: [php], engine: createOnigurumaEngine(import('shiki/wasm')) });
    const tokens = hl.codeToTokensBase('<?php\n$name = "bolt"; // hi\nreturn 42;\n', { lang: 'php', theme: 'darcula' }).flat();
    // Shiki merges neighbours of one colour: `"bolt"` and `$name` arrive as one token each.
    const color = (text: string) => tokens.find((t) => t.content.trim().replace(/^["$]|"$/g, '') === text)?.color?.toLowerCase();
    expect(color('bolt')).toBe('#6a8759');
    expect(color('name')).toBe('#9876aa');
    expect(color('return')).toBe('#cc7832');
    expect(color('42')).toBe('#6897bb');
    expect(tokens.find((t) => t.content.includes('hi'))?.color?.toLowerCase()).toBe('#808080');
    hl.dispose();
  });

  it('gives Monaco an editor background and foreground', () => {
    expect(darcula.type).toBe('dark');
    expect(darcula.colors?.['editor.background']).toBe('#2B2B2B');
    expect(darcula.colors?.['editor.foreground']).toBe('#A9B7C6');
  });
});
