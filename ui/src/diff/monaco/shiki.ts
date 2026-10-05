import { shikiToMonaco } from '@shikijs/monaco';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { bundledLanguages } from 'shiki/langs';
import { currentEditorTheme, editorThemeRegistrations } from '../../theme/editorThemes';
import { memoizeUntilRejected } from './memo';
import type { Monaco } from './setup';

// The Oniguruma WASM (inlined as base64 by shiki/wasm) loads with the first diff (spec §10.3).
// Every theme carries its GitBolt editor colours (theme.ts): `shikiToMonaco` redefines them from Shiki's
// copy on every grammar load, so that copy is where they must live.
const getHighlighter = memoizeUntilRejected(() =>
  createHighlighterCore({
    themes: editorThemeRegistrations(),
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  }),
);

/** `shikiToMonaco` ends every call by selecting the first loaded theme, which would throw the app
 * theme away on each grammar load: select the current one again. */
function defineThemes(h: Parameters<typeof shikiToMonaco>[0], monaco: Monaco): void {
  shikiToMonaco(h, monaco);
  monaco.editor.setTheme(currentEditorTheme());
}

let themed: Promise<void> | undefined;

/** Defines the editor themes and applies the app's. It must resolve before the first editor is created:
 * Monaco falls back to its light `vs` theme for an unknown theme name, and a later defineTheme
 * doesn't re-apply it (so a plain-text-only session would stay light). */
export function ensureTheme(monaco: Monaco): Promise<void> {
  return (themed ??= getHighlighter().then(
    (h) => defineThemes(h, monaco),
    (e: unknown) => {
      themed = undefined;
      throw e;
    },
  ));
}

const languages = new Map<string, Promise<string>>();

async function load(monaco: Monaco, lang: keyof typeof bundledLanguages): Promise<string> {
  const h = await getHighlighter();
  await h.loadLanguage(bundledLanguages[lang]);
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  for (const id of h.getLoadedLanguages()) if (!known.has(id)) monaco.languages.register({ id });
  // Registers a TextMate tokenizer for every loaded language (including embedded ones, like
  // the html/css/js inside php) and defines the theme. Called once per newly loaded grammar: this
  // is @shikijs/monaco's documented way of adding languages.
  defineThemes(h, monaco);
  return lang;
}

/** Loads a language's grammar the first time a file of that language opens. Resolves to the
 * Monaco language id to use (`plaintext` for anything Shiki doesn't ship). */
export function ensureLanguage(monaco: Monaco, lang: string): Promise<string> {
  if (!Object.hasOwn(bundledLanguages, lang)) return Promise.resolve('plaintext');
  let p = languages.get(lang);
  if (!p) {
    p = load(monaco, lang as keyof typeof bundledLanguages);
    languages.set(lang, p);
    p.catch(() => languages.delete(lang));
  }
  return p;
}

// --- 5A T8: Markdown code blocks (spec #5 §3.1) ---
export interface CodeTokens { lines: Array<Array<{ content: string; color?: string; fontStyle?: number }>>; fg?: string; bg?: string }

const grammars = new Map<string, Promise<void>>();
let loaded: Awaited<ReturnType<typeof getHighlighter>> | null = null;

/** Loads a fenced block's grammar (once) on the diff's highlighter; resolves the language id, or
 * `null` for a language Shiki doesn't ship (the block stays plain). */
export async function ensureGrammar(lang: string): Promise<string | null> {
  const id = lang.toLowerCase();
  if (!Object.hasOwn(bundledLanguages, id)) return null;
  const h = await getHighlighter();
  let p = grammars.get(id);
  if (!p) {
    p = h.loadLanguage(bundledLanguages[id as keyof typeof bundledLanguages]).then(() => {});
    grammars.set(id, p);
    p.catch(() => grammars.delete(id));
  }
  await p;
  loaded = h;
  return id;
}

/** A block's tokens in the current editor theme, synchronously (`ensureGrammar(id)` resolved
 * first): the highlight queue times each call. */
export function tokensFor(code: string, id: string): CodeTokens {
  if (!loaded) throw new Error('tokensFor before ensureGrammar');
  const r = loaded.codeToTokens(code, { lang: id, theme: currentEditorTheme() });
  return { lines: r.tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color, fontStyle: t.fontStyle }))), fg: r.fg, bg: r.bg };
}
// --- end 5A T8 ---
