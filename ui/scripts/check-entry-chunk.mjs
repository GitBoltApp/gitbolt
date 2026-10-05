// Spec §10.3: Monaco, Shiki's grammars and registry, and the Oniguruma WASM load on the first
// diff, never at startup. Run after `vite build` (it's part of `npm run build`): fails if any
// of them reached a chunk the app shell loads eagerly, i.e. the entry script in dist/index.html
// and every chunk it modulepreloads.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// The minifier renames module-local bindings, so `bundledLanguagesInfo` itself never appears in
// a production chunk. Each module is therefore also caught by a string that survives
// minification (a property key or a string literal); all of them were checked against a build
// that imported language.ts and host.ts eagerly.
const MARKERS = [
  'bundledLanguagesInfo', // shiki/langs registry, by name (unminified builds)
  'Angular TypeScript', // shiki/langs registry (a language name in bundledLanguagesInfo), minified
  'createDiffEditor', // monaco-editor/editor/editor.api (a namespace property key)
  'ShikiError', // shiki/core
  'AGFzbQ', // shiki/wasm: the Oniguruma WASM inlined as base64 ("\0asm" magic)
  'tableDelimiter', // micromark's GFM table tokens (remark-gfm): the Markdown renderer stays lazy (spec #5 §3.1)
  'dataFootnoteBackref', // hast-util-sanitize's default schema (rehype-sanitize), minified
  'No diagram type detected matching given configuration', // mermaid's core (detectType's error): Mermaid loads on the first diagram (spec #5 §3.1)
];

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const eager = [
  ...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g),
  ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
].map((m) => m[1].replace(/^\//, ''));

if (!eager.some((f) => /(^|\/)index-[^/]*\.js$/.test(f))) {
  console.error(`check-entry-chunk: no entry index-*.js script found in dist/index.html (got: ${eager.join(', ') || 'none'})`);
  process.exit(1);
}

let failed = false;
for (const file of eager) {
  const code = readFileSync(join(dist, file), 'utf8');
  const found = MARKERS.filter((m) => code.includes(m));
  if (found.length) {
    failed = true;
    console.error(`check-entry-chunk: ${file} is loaded at startup but contains ${found.join(', ')}; Monaco, Shiki, the Markdown renderer and Mermaid must stay in lazy chunks (spec §10.3, spec #5 §3.1).`);
  }
}
if (failed) process.exit(1);
console.log(`check-entry-chunk: OK (${eager.join(', ')} free of Monaco, Shiki, the Markdown renderer and Mermaid)`);
