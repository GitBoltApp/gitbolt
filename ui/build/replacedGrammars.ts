// Shiki grammars GitBolt replaces with its own files (build/license-exceptions.json `replaced`,
// docs/licensing.md): src/diff/shikiLanguages.ts imports those files directly, but some of Shiki's
// grammars embed a replaced one (cpp, elm, nim and es-tag-glsl import './glsl.mjs'). This plugin
// resolves those imports to GitBolt's file too, so Shiki's copy is never bundled (the license
// notices fail the build if it is).
import { join } from 'node:path';
import type { Plugin } from 'vite';

const PREFIX = '\0gitbolt-grammar:';

export function replacedGrammars(opts: { root: string; ids: string[] }): Plugin {
  const ids = new Set(opts.ids);
  const fromShiki = (source: string, importer: string | undefined): string | null => {
    const relative = /^\.\/([^/]+)\.mjs$/.exec(source);
    if (relative && importer && /[\\/]node_modules[\\/]@shikijs[\\/]langs[\\/]dist[\\/][^\\/]+$/.test(importer)) return relative[1];
    return /^(?:shiki\/langs\/([^/]+)\.mjs|@shikijs\/langs\/([^/]+))$/.exec(source)?.slice(1).find(Boolean) ?? null;
  };
  return {
    name: 'gitbolt-replaced-grammars',
    enforce: 'pre',
    resolveId(source, importer) {
      const id = fromShiki(source, importer);
      return id && ids.has(id) ? `${PREFIX}${id}` : null;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const file = join(opts.root, 'src', 'diff', 'grammars', `${id.slice(PREFIX.length)}.json`);
      // A Shiki grammar module: the default export is the list of registrations to load.
      return `import grammar from ${JSON.stringify(file)};\nexport default [grammar];\n`;
    },
  };
}
