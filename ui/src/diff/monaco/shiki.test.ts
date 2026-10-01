import { describe, expect, it, vi } from 'vitest';
import type { Monaco } from './setup';

const createHighlighterCore = vi.fn();
vi.mock('shiki/core', () => ({ createHighlighterCore }));
vi.mock('shiki/engine/oniguruma', () => ({ createOnigurumaEngine: () => ({}) }));
vi.mock('shiki/wasm', () => ({ default: {} }));
vi.mock('@shikijs/monaco', () => ({ shikiToMonaco: vi.fn() }));

const monaco = { editor: { setTheme: vi.fn() }, languages: { getLanguages: () => [], register: vi.fn() } } as unknown as Monaco;
const highlighter = { loadLanguage: vi.fn(async () => {}), getLoadedLanguages: () => ['php'] };

describe('Shiki highlighter', () => {
  it('retries after the highlighter itself failed to start, instead of caching the failure', async () => {
    createHighlighterCore.mockRejectedValueOnce(new Error('wasm failed')).mockResolvedValue(highlighter);
    const { ensureLanguage } = await import('./shiki');
    await expect(ensureLanguage(monaco, 'php')).rejects.toThrow('wasm failed');
    await expect(ensureLanguage(monaco, 'php')).resolves.toBe('php');
    expect(createHighlighterCore).toHaveBeenCalledTimes(2);
    await expect(ensureLanguage(monaco, 'not-a-shiki-language')).resolves.toBe('plaintext');
  });

  it("creates the highlighter with every theme carrying its editor colours, so every theme definition has them", async () => {
    vi.resetModules();
    createHighlighterCore.mockReset().mockResolvedValue(highlighter);
    const { ensureLanguage } = await import('./shiki');
    const { EDITOR_COLORS } = await import('./theme');
    await ensureLanguage(monaco, 'php');
    const [{ themes }] = createHighlighterCore.mock.calls[0] as [{ themes: unknown[] }];
    const theme = (await themes[0]) as { name: string; colors: Record<string, string> };
    expect(theme.name).toBe('dark-plus');
    expect(theme.colors).toMatchObject(EDITOR_COLORS);
    expect(theme.colors['editor.background']).toBeDefined();
  });
});
