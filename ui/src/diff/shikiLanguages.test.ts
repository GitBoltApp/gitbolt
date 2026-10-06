import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { bundledLanguagesInfo as shikiInfo } from 'shiki/langs';
import { describe, expect, it } from 'vitest';
import exceptions from '../../build/license-exceptions.json';
import { detectLanguage } from './language';
import { bundledLanguages, bundledLanguagesInfo } from './shikiLanguages';

const dropped = Object.keys(exceptions.dropped.grammars);
const replaced = Object.keys(exceptions.replaced.grammars);
const droppedNames = shikiInfo.filter((l) => dropped.includes(l.id)).flatMap((l) => [l.id, ...(l.aliases ?? [])]);

describe("GitBolt's Shiki language registry", () => {
  it('leaves out the dropped grammars (copyleft, or no license upstream) and their aliases', () => {
    expect(dropped).toEqual(expect.arrayContaining(['ada', 'gnuplot', 'nginx', 'org', 'racket', 'ahk2', 'dax']));
    expect(droppedNames.length).toBeGreaterThanOrEqual(dropped.length);
    for (const name of droppedNames) {
      expect(bundledLanguagesInfo.map((l) => l.id)).not.toContain(name);
      expect(Object.hasOwn(bundledLanguages, name)).toBe(false);
    }
  });

  it("is Shiki's registry minus the dropped grammars (regenerate it after a Shiki upgrade: node scripts/gen-shiki-languages.mjs)", () => {
    const strip = (l: { id: string; name: string; aliases?: string[] }) => ({ id: l.id, name: l.name, aliases: l.aliases ?? [] });
    expect(bundledLanguagesInfo.map(strip)).toEqual(shikiInfo.filter((l) => !dropped.includes(l.id)).map(strip));
    const keys = Object.keys(bundledLanguages).sort();
    expect(keys).toEqual(bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])]).sort());
  });

  it("imports each grammar by its own id, glsl and tcl from GitBolt's files, and never a dropped or replaced Shiki one", () => {
    expect(replaced.sort()).toEqual(['glsl', 'tcl']);
    const src = readFileSync(join(process.cwd(), 'src/diff/shikiLanguages.ts'), 'utf8');
    const specifiers = [...src.matchAll(/import\('(?:shiki\/langs\/([^']+)\.mjs'\)|\.\/grammars\/([^']+)\.json', \{ with: \{ type: 'json' \} \}\))/g)].map((m) => m[1] ?? `ours:${m[2]}`);
    expect(specifiers).toEqual(bundledLanguagesInfo.map((l) => (replaced.includes(l.id) ? `ours:${l.id}` : l.id)));
    for (const id of [...dropped, ...replaced]) expect(src).not.toContain(`'shiki/langs/${id}.mjs'`);
    for (const id of replaced) expect(existsSync(join(process.cwd(), `src/diff/grammars/${id}.json`)), id).toBe(true);
  });

  it('shows a file in a dropped language as plain text', () => {
    for (const name of droppedNames) expect(detectLanguage(`file.${name}`)).toBe('plaintext');
    expect(detectLanguage('measures.dax')).toBe('plaintext');
    expect(detectLanguage('main.rs')).toBe('rust');
    expect(detectLanguage('config.yml')).toBe('yaml');
  });

  it("maps shader and Tcl files to GitBolt's glsl and tcl grammars", () => {
    for (const ext of ['glsl', 'vert', 'frag', 'geom', 'tesc', 'tese', 'comp', 'vsh', 'fsh', 'gsh', 'vshader', 'fshader', 'gshader'])
      expect(detectLanguage(`shaders/basic.${ext}`), ext).toBe('glsl');
    expect(detectLanguage('script.fs')).toBe('fsharp');
    expect(detectLanguage('build.tcl')).toBe('tcl');
    expect(detectLanguage('build', '#!/usr/bin/env tclsh')).toBe('tcl');
  });
});

describe("GitBolt's glsl and tcl grammars", () => {
  async function scopes(lang: string, code: string) {
    const h = await createHighlighterCore({ themes: [import('shiki/themes/dark-plus.mjs')], langs: [bundledLanguages[lang]], engine: createOnigurumaEngine(import('shiki/wasm')) });
    try {
      const lines = h.codeToTokensBase(code, { lang, theme: 'dark-plus', includeExplanation: 'scopeName' });
      return new Map(lines.flat().flatMap((t) => (t.explanation ?? []).map((e) => [e.content.trim(), e.scopes.map((s) => s.scopeName)] as const)));
    } finally {
      h.dispose();
    }
  }

  it('highlights a shader', async () => {
    const s = await scopes('glsl', [
      '#version 330 core',
      '// a comment',
      'uniform mat4 mvp;',
      'in vec3 position;',
      'void main() {',
      '  gl_Position = mvp * vec4(position, 1.0);',
      '}',
    ].join('\n'));
    expect(s.get('uniform')).toEqual(expect.arrayContaining(['source.glsl', 'storage.modifier.glsl']));
    expect(s.get('vec4')).toEqual(expect.arrayContaining(['storage.type.glsl']));
    expect(s.get('gl_Position')).toEqual(expect.arrayContaining(['support.variable.glsl']));
    expect(s.get('1.0')).toEqual(expect.arrayContaining(['constant.numeric.glsl']));
    expect([...s.values()].flat()).toContain('comment.line.double-slash.glsl');
  });

  it('highlights a Tcl script', async () => {
    const s = await scopes('tcl', ['# a comment', 'proc greet {name} {', '  puts "Hello, $name"', '}', 'if {1} { greet world }'].join('\n'));
    expect(s.get('proc')).toEqual(expect.arrayContaining(['source.tcl', 'keyword.other.tcl']));
    expect(s.get('if')).toEqual(expect.arrayContaining(['keyword.control.tcl']));
    expect([...s.values()].flat()).toEqual(expect.arrayContaining(['comment.line.number-sign.tcl', 'string.quoted.double.tcl', 'variable.other.tcl']));
  });
});
