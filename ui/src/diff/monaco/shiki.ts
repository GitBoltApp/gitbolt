import { shikiToMonaco } from '@shikijs/monaco';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { bundledLanguages } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';
import { memoizeUntilRejected } from './memo';
import type { Monaco } from './setup';

/** Default Dark's editor theme (spec §12.1). Plan 1D pairs one with every app theme. */
export const EDITOR_THEME = 'dark-plus';

// The Oniguruma WASM (inlined as base64 by shiki/wasm) loads with the first diff (spec §10.3).
const getHighlighter = memoizeUntilRejected(() =>
  createHighlighterCore({ themes: [bundledThemes[EDITOR_THEME]], langs: [], engine: createOnigurumaEngine(import('shiki/wasm')) }),
);

let themed: Promise<void> | undefined;

/** Defines and applies EDITOR_THEME in Monaco. It must resolve before the first editor is created:
 * Monaco falls back to its light `vs` theme for an unknown theme name, and a later defineTheme
 * doesn't re-apply it (so a plain-text-only session would stay light). */
export function ensureTheme(monaco: Monaco): Promise<void> {
  return (themed ??= getHighlighter().then(
    (h) => shikiToMonaco(h, monaco),
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
  shikiToMonaco(h, monaco);
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
