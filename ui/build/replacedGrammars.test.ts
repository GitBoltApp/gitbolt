import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replacedGrammars } from './replacedGrammars';

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const call = (hook: unknown, ...args: unknown[]) => (hook as Hook).call({}, ...args);

describe("the plugin that swaps Shiki's replaced grammars for GitBolt's files", () => {
  const root = '/repo/ui';
  const plugin = replacedGrammars({ root, ids: ['glsl', 'tcl'] });
  const langs = '/repo/ui/node_modules/@shikijs/langs/dist';

  it("resolves a Shiki grammar's import of a replaced one (cpp embeds glsl) to GitBolt's file", () => {
    expect(call(plugin.resolveId, './glsl.mjs', `${langs}/cpp.mjs`)).toBe('\0gitbolt-grammar:glsl');
    expect(call(plugin.resolveId, 'shiki/langs/tcl.mjs', '/repo/ui/src/x.ts')).toBe('\0gitbolt-grammar:tcl');
    expect(call(plugin.resolveId, '@shikijs/langs/glsl', '/repo/ui/src/x.ts')).toBe('\0gitbolt-grammar:glsl');
  });

  it('leaves every other import alone', () => {
    expect(call(plugin.resolveId, './regexp.mjs', `${langs}/cpp.mjs`)).toBeNull();
    expect(call(plugin.resolveId, './glsl.mjs', '/repo/ui/src/diff/other.ts')).toBeNull();
    expect(call(plugin.resolveId, 'shiki/langs/c.mjs', '/repo/ui/src/x.ts')).toBeNull();
    expect(call(plugin.resolveId, './glsl.mjs', undefined)).toBeNull();
  });

  it("loads the replacement as a Shiki grammar module made of GitBolt's JSON", () => {
    const code = call(plugin.load, '\0gitbolt-grammar:glsl') as string;
    expect(code).toContain(`import grammar from ${JSON.stringify(join(root, 'src/diff/grammars/glsl.json'))}`);
    expect(code).toContain('export default [grammar]');
    expect(call(plugin.load, '/repo/ui/src/x.ts')).toBeNull();
  });
});
