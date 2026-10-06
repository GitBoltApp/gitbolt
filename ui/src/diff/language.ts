// Shiki's language registry is part of the lazy diff chunk, not the startup chunk (spec §10.3):
// only modules reached from diff/monaco/load.ts or a React.lazy diff panel may import this file.
// `npm run build` fails if Shiki's registry shows up in the entry chunk (scripts/check-entry-chunk.mjs).
// The registry is GitBolt's copy, without the grammars dropped for their licenses: a file in one
// of those languages is plain text.
import { bundledLanguagesInfo } from './shikiLanguages';

/** The plan's name, but it's compared with `text.length`, i.e. UTF-16 code units, not bytes. */
export const HIGHLIGHT_MAX_BYTES = 1_048_576;
export const HIGHLIGHT_MAX_LINES = 20_000;

/** Shiki ids and aliases (`ts`, `yml`, `md`, `rs`, `sh`, …) → id. */
const BY_NAME = new Map<string, string>(bundledLanguagesInfo.flatMap((l) => [[l.id, l.id], ...(l.aliases ?? []).map((a) => [a, l.id])] as [string, string][]));

// Maps, not object literals: a lookup of `constructor` or `__proto__` must not find
// Object.prototype's members.
const table = (entries: Record<string, string>) => new Map(Object.entries(entries));

/** Extensions Shiki's registry doesn't list (it has ids and aliases, not extensions). */
const EXTENSIONS = table({
  phtml: 'php', inc: 'php', h: 'c', hpp: 'cpp', hh: 'cpp', cc: 'cpp', cxx: 'cpp', htm: 'html', xhtml: 'html',
  svg: 'xml', xsd: 'xml', plist: 'xml', bash: 'shellscript', zsh: 'shellscript', ps1: 'powershell', kt: 'kotlin',
  kts: 'kotlin', rb: 'ruby', pl: 'perl', pm: 'perl', cs: 'csharp', ex: 'elixir', exs: 'elixir', erl: 'erlang',
  hs: 'haskell', ml: 'ocaml', tf: 'terraform', gql: 'graphql', cfg: 'ini', conf: 'ini', neon: 'yaml', markdown: 'markdown',
  // Shader stages (GitBolt's glsl grammar's file types, less the ambiguous vs/fs/gs: fs is F#).
  vert: 'glsl', frag: 'glsl', geom: 'glsl', tesc: 'glsl', tese: 'glsl', comp: 'glsl', vsh: 'glsl', fsh: 'glsl', gsh: 'glsl',
  vshader: 'glsl', fshader: 'glsl', gshader: 'glsl',
});

const FILENAMES = table({
  dockerfile: 'docker', makefile: 'make', gnumakefile: 'make', 'cmakelists.txt': 'cmake', 'composer.lock': 'json',
  'cargo.lock': 'toml', '.editorconfig': 'ini', '.gitconfig': 'ini', justfile: 'just',
});

const SHEBANGS = table({
  bash: 'shellscript', sh: 'shellscript', zsh: 'shellscript', dash: 'shellscript', node: 'javascript', deno: 'typescript',
  python: 'python', python3: 'python', php: 'php', ruby: 'ruby', perl: 'perl', tclsh: 'tcl',
});

/** Spec §10.3: by extension or file name (Shiki's registry plus the tables above), then by
 * shebang, then plain text. */
export function detectLanguage(path: string, firstLine = ''): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName = FILENAMES.get(name);
  if (byName) return byName;
  if (name === '.env' || name.startsWith('.env.')) return 'dotenv';
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const ext = name.slice(dot + 1);
    const lang = BY_NAME.get(ext) ?? EXTENSIONS.get(ext);
    if (lang) return lang;
  }
  const interp = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?([A-Za-z0-9]+)/.exec(firstLine)?.[1];
  return (interp && SHEBANGS.get(interp)) || 'plaintext';
}

/** `detectLanguage`, or plain text above the highlighting limit (1 MiB or 20k lines). */
export function highlightLanguage(path: string, text: string): string {
  if (text.length > HIGHLIGHT_MAX_BYTES) return 'plaintext';
  let lines = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (++lines > HIGHLIGHT_MAX_LINES) return 'plaintext';
  }
  const nl = text.indexOf('\n');
  return detectLanguage(path, nl === -1 ? text : text.slice(0, nl));
}
