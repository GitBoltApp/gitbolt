import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptedFromAboutToml, buildUiNotices, chooseLicense, copyrightLines, type Exceptions, packageDirOf } from './licenses';

const ACCEPTED = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'MPL-2.0'];
const MIT = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.\n\nTHE SOFTWARE IS PROVIDED "AS IS".';

describe('acceptedFromAboutToml', () => {
  it('reads the allow-list shared with cargo-about, in order', () => {
    expect(acceptedFromAboutToml('# c\naccepted = [\n  "MIT",\n  "Apache-2.0", # x\n  "Apache-2.0 WITH LLVM-exception",\n]\ntargets = ["a"]\n'))
      .toEqual(['MIT', 'Apache-2.0', 'Apache-2.0 WITH LLVM-exception']);
  });
  it('matches the real about.toml', () => {
    const list = acceptedFromAboutToml(readFileSync(join(process.cwd(), '..', 'about.toml'), 'utf8'));
    expect(list).toContain('MIT');
    expect(list.some((l) => /GPL/.test(l))).toBe(false);
  });
});

describe('chooseLicense', () => {
  it('takes a plain accepted id', () => expect(chooseLicense('MIT', ACCEPTED)).toEqual(['MIT']));
  it('picks the earliest accepted license of a choice', () => {
    expect(chooseLicense('(MPL-2.0 OR Apache-2.0)', ACCEPTED)).toEqual(['Apache-2.0']);
    expect(chooseLicense('Apache-2.0 OR MIT', ACCEPTED)).toEqual(['MIT']);
    expect(chooseLicense('GPL-3.0 OR MIT', ACCEPTED)).toEqual(['MIT']);
  });
  it('needs every part of a conjunction', () => {
    expect(chooseLicense('MIT AND ISC', ACCEPTED)).toEqual(['MIT', 'ISC']);
    expect(chooseLicense('(MIT OR Apache-2.0) AND BSD-3-Clause', ACCEPTED)).toEqual(['MIT', 'BSD-3-Clause']);
    expect(chooseLicense('MIT AND GPL-2.0', ACCEPTED)).toBeNull();
  });
  it('rejects copyleft, unknown and missing licenses', () => {
    for (const l of ['GPL-3.0', 'LGPL-2.1-or-later', 'AGPL-3.0', 'UNLICENSED', 'SEE LICENSE IN x', '', 'NOASSERTION']) {
      expect(chooseLicense(l, ACCEPTED)).toBeNull();
    }
  });
});

describe('packageDirOf', () => {
  it('finds the innermost package, scoped or not', () => {
    expect(packageDirOf('/r/ui/node_modules/react/cjs/react.production.js')).toEqual({ dir: '/r/ui/node_modules/react', name: 'react' });
    expect(packageDirOf('/r/ui/node_modules/@shikijs/langs/dist/rust.mjs?x')).toEqual({ dir: '/r/ui/node_modules/@shikijs/langs', name: '@shikijs/langs' });
    expect(packageDirOf('\0/r/ui/node_modules/a/node_modules/b/i.js?commonjs-proxy')).toEqual({ dir: '/r/ui/node_modules/a/node_modules/b', name: 'b' });
  });
  it('ignores our own sources and other virtual modules', () => {
    expect(packageDirOf('/r/ui/src/main.tsx')).toBeNull();
    expect(packageDirOf('\0virtual:thing')).toBeNull();
  });
});

describe('copyrightLines', () => {
  it('keeps real copyright lines, not the license wording or placeholders', () => {
    expect(copyrightLines('MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nThe above copyright notice and this permission notice\nTHE COPYRIGHT HOLDERS\n   Copyright [yyyy] [name of copyright owner]\n(c) 2019 Someone\n'))
      .toEqual(['Copyright (c) Meta Platforms, Inc. and affiliates.', '(c) 2019 Someone']);
  });
});

function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'gb-licenses-'));
  const pkg = (name: string, json: object, files: Record<string, string> = {}) => {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...json }));
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    return join(dir, 'index.js');
  };
  return { root, pkg };
}

describe('buildUiNotices', () => {
  it('groups the bundled packages by license, each text once, with every copyright line', () => {
    const { root, pkg } = fakeRepo();
    const ids = [
      pkg('alpha', { license: 'MIT' }, { LICENSE: `MIT License\n\nCopyright (c) 2020 Alpha\n\n${MIT}` }),
      pkg('beta', { license: 'MIT', author: { name: 'Beta Dev' } }, { 'LICENSE.md': `Copyright 2021 Beta\n${MIT.replace(/\n/g, ' ')}` }),
      pkg('nofile', { license: 'MIT', author: 'No File <x@example.invalid>' }),
      pkg('dual', { license: '(MPL-2.0 OR Apache-2.0)' }, { LICENSE: 'Apache License\nVersion 2.0\nCopyright 2015 Dual', 'LICENSE-MPL': 'Mozilla Public License' }),
      pkg('monacoish', { license: 'MIT' }, { LICENSE: `Copyright (c) Monaco\n${MIT}`, 'ThirdPartyNotices.txt': 'Notice: includes code from elsewhere.' }),
      join(root, 'src', 'main.tsx'),
    ];
    // The bundler's own helpers (Vite's preload helper, Rolldown's runtime) are virtual modules.
    pkg('vite', { license: 'MIT' }, { LICENSE: `Copyright (c) Vite\n${MIT}` });
    ids.push('\0vite/preload-helper.js', '\0virtual:other');
    const r = buildUiNotices({ moduleIds: ids, accepted: ACCEPTED, exceptions: {}, root });
    expect(r.errors).toEqual([]);
    const t = r.text;
    expect(t).toContain('vite 1.0.0\n  Copyright (c) Vite');
    expect(t).toMatch(/^ *MIT +5$/m);
    expect(t).toMatch(/^ *Apache-2.0 +1$/m);
    expect(t.match(/Permission is hereby granted/g)).toHaveLength(1);
    expect(t).toContain('alpha 1.0.0\n  Copyright (c) 2020 Alpha');
    expect(t).toContain('beta 1.0.0\n  Copyright 2021 Beta');
    expect(t).toMatch(/nofile 1\.0\.0\n {2}\(no license file in the package; author: No File\)/);
    expect(t).toContain('dual 1.0.0\n  Copyright 2015 Dual');
    expect(t).not.toContain('Mozilla Public License');
    expect(t).toContain('Notice: includes code from elsewhere.');
    expect(r.counts).toEqual({ MIT: 5, 'Apache-2.0': 1 });
  });

  it('points to the source of a package under EPL-2.0 (npm package and repository)', () => {
    const { pkg } = fakeRepo();
    const ids = [
      pkg('elkish', { license: 'EPL-2.0', version: '0.9.3', repository: { type: 'vcs', url: 'https://example.invalid/example/elkish.repo' } }, { LICENSE: '# Eclipse Public License - v 2.0\n\nTHE ACCOMPANYING PROGRAM' }),
      pkg('ok', { license: 'MIT' }, { LICENSE: MIT }),
    ];
    const r = buildUiNotices({ moduleIds: ids, accepted: [...ACCEPTED, 'EPL-2.0'], exceptions: {} });
    expect(r.errors).toEqual([]);
    expect(r.text).toContain('Source code of the packages under a file-level copyleft license');
    expect(r.text).toContain('elkish 0.9.3 (EPL-2.0)\n  npm package: https://www.npmjs.com/package/elkish/v/0.9.3\n  source repository: https://example.invalid/example/elkish.repo');
    expect(r.text).toContain('Eclipse Public License - v 2.0');
  });

  it('fails on a copyleft or unknown license, and names the package', () => {
    const { pkg } = fakeRepo();
    const ids = [pkg('gpl', { license: 'GPL-3.0' }, { LICENSE: 'GNU GPL' }), pkg('none', {}), pkg('ok', { license: 'MIT' }, { LICENSE: MIT })];
    const r = buildUiNotices({ moduleIds: ids, accepted: ACCEPTED, exceptions: {} });
    expect(r.errors.join('\n')).toMatch(/gpl 1\.0\.0: GPL-3\.0/);
    expect(r.errors.join('\n')).toMatch(/none 1\.0\.0: \(no license\)/);
    expect(r.errors).toHaveLength(2);
  });

  it('applies a clarified license to a package that declares none', () => {
    const { pkg } = fakeRepo();
    const ids = [pkg('khromaish', {}, { license: `Copyright (c) K\n${MIT}` })];
    const r = buildUiNotices({ moduleIds: ids, accepted: ACCEPTED, exceptions: { packages: { khromaish: { license: 'MIT', reason: 'its license file is MIT' } } } });
    expect(r.errors).toEqual([]);
    expect(r.text).toContain('khromaish 1.0.0\n  Copyright (c) K');
  });


  describe("Shiki's grammars and themes", () => {
    const SEP = `${'='.repeat(105)}\n`;
    const section = (files: string[], text: string) => `${SEP}Files:   ${files.join(', ')}\nLicense: https://example.invalid/LICENSE\nSPDX:    MIT\n${'-'.repeat(105)}\n${text}\n\n`;
    const meta = {
      grammars: [
        { name: 'rust', license: 'MIT', source: 'https://example.invalid/rust' },
        { name: 'nginx', license: 'GPL-3.0', source: 'https://example.invalid/nginx' },
        { name: 'abap', source: 'https://example.invalid/abap' },
        { name: 'yaml', source: 'https://example.invalid/yaml' },
        { name: 'apache', license: 'NOASSERTION', source: 'https://example.invalid/apache' },
        { name: 'dax', source: 'https://example.invalid/dax' },
        { name: 'unused', license: 'GPL-3.0', source: 'https://example.invalid/unused' },
      ],
      themes: [
        { name: 'nord', license: 'MIT', source: 'https://example.invalid/nord' },
        { name: 'aurora-x', license: 'GPL-3.0', source: 'https://example.invalid/aurora-x' },
      ],
    };
    function shikiRepo(grammars: string[], themes = ['nord']) {
      const { root, pkg } = fakeRepo();
      const langs = pkg('@shikijs/langs', { license: 'MIT' }, { LICENSE: `Copyright (c) Shiki\n${MIT}` });
      const themesPkg = pkg('@shikijs/themes', { license: 'MIT' }, { LICENSE: `Copyright (c) Shiki\n${MIT}` });
      pkg('tm-grammars', { license: 'MIT' }, {
        NOTICE: `GRAMMARS NOTICE HEADER\n\n${section(['rust.json', 'other.json'], 'RUST TEXT')}${section(['apache.json'], 'APACHE TEXT')}${section(['unused.json'], 'UNUSED TEXT')}`,
      });
      pkg('tm-themes', { license: 'MIT' }, { NOTICE: `THEMES NOTICE HEADER\n\n${section(['nord.json'], 'NORD TEXT')}${section(['aurora-x.json'], 'AURORA TEXT')}` });
      const texts = join(root, 'grammar-licenses');
      mkdirSync(texts);
      writeFileSync(join(texts, 'abap.txt'), 'ABAP TEXT: Permission to copy, use, modify, sell and distribute this software is granted.');
      writeFileSync(join(texts, 'yaml.txt'), 'Copyright (c) 2015 Yaml Author\nYAML TEXT');
      const ids = [
        ...grammars.map((g) => langs.replace('index.js', `dist/${g}.mjs`)),
        langs.replace('index.js', 'dist/index.mjs'),
        ...themes.map((t) => themesPkg.replace('index.js', `dist/${t}.mjs`)),
      ];
      return { root, ids, grammarLicenseDir: texts };
    }
    const reviewed = {
      licenses: { 'LicenseRef-TextMate-Bundle': 'permissive: permission to copy, use, modify, sell and distribute' },
      grammars: {
        abap: { recorded: '(none)', license: 'LicenseRef-TextMate-Bundle', source: 'https://example.invalid/abap/README', reason: 'r' },
        yaml: { recorded: '(none)', license: 'MIT', source: 'https://example.invalid/yaml/YAML-license.txt', reason: 'r' },
        apache: { recorded: 'NOASSERTION', license: 'BSD-3-Clause', source: 'https://example.invalid/apache/LICENSE', reason: 'r' },
        gone: { recorded: '(none)', license: 'MIT', source: 'https://example.invalid/gone', reason: 'r' },
      },
    };

    it('holds every bundled grammar and theme to the allow-list', () => {
      const repo = shikiRepo(['rust', 'nginx', 'abap']);
      const r = buildUiNotices({ moduleIds: repo.ids, accepted: ACCEPTED, exceptions: {}, shiki: meta, root: repo.root, grammarLicenseDir: repo.grammarLicenseDir });
      expect(r.errors.join('\n')).toMatch(/grammar nginx: GPL-3\.0/);
      expect(r.errors.join('\n')).toMatch(/grammar abap: \(no license\)/);
      expect(r.errors.join('\n')).not.toMatch(/unused/);
    });

    it('never bundles a copyleft grammar or theme, even one the exceptions name, nor a dropped one', () => {
      const repo = shikiRepo(['rust', 'nginx'], ['nord', 'aurora-x']);
      const r = buildUiNotices({
        moduleIds: repo.ids, accepted: ACCEPTED, shiki: meta, root: repo.root, grammarLicenseDir: repo.grammarLicenseDir,
        exceptions: {
          dropped: { grammars: { nginx: 'GPL-3.0' }, themes: {} },
          grammars: { nginx: { recorded: 'GPL-3.0', license: 'GPL-3.0', source: 'https://example.invalid/nginx', reason: 'r' } },
        },
      });
      const errors = r.errors.join('\n');
      expect(errors).toMatch(/grammar nginx: .*dropped/);
      expect(errors).toMatch(/grammar nginx: .*copyleft/);
      expect(errors).toMatch(/theme aurora-x: .*copyleft/);
    });

    it('lists each with its real license, source and text, ', () => {
      const repo = shikiRepo(['rust', 'abap', 'yaml', 'apache']);
      const r = buildUiNotices({ moduleIds: repo.ids, accepted: ACCEPTED, exceptions: reviewed, shiki: meta, root: repo.root, grammarLicenseDir: repo.grammarLicenseDir });
      expect(r.errors).toEqual([]);
      const t = r.text;
      expect(t).toMatch(/rust +MIT +https:\/\/example\.invalid\/rust\n/);
      expect(t).toMatch(/abap +LicenseRef-TextMate-Bundle +https:\/\/example\.invalid\/abap\/README +\(tm-grammars records no license\)/);
      expect(t).toMatch(/apache +BSD-3-Clause +https:\/\/example\.invalid\/apache\/LICENSE +\(tm-grammars records NOASSERTION\)/);
      expect(t).toMatch(/nord +MIT/);
      // The upstream texts: tm-grammars' NOTICE sections for the bundled grammars only, plus the
      // texts recorded here for those its NOTICE lacks.
      expect(t).toContain('RUST TEXT');
      expect(t).toContain('APACHE TEXT');
      expect(t).not.toContain('UNUSED TEXT');
      expect(t).toContain('NORD TEXT');
      expect(t).not.toContain('AURORA TEXT');
      expect(t).toMatch(/abap \(LicenseRef-TextMate-Bundle\), from https:\/\/example\.invalid\/abap\/README[\s\S]*ABAP TEXT/);
      expect(t).toMatch(/yaml \(MIT\), from https:\/\/example\.invalid\/yaml\/YAML-license\.txt[\s\S]*YAML TEXT/);
      expect(t).toMatch(/LicenseRef-TextMate-Bundle: permissive: permission to copy/);
      expect(r.warnings.join('\n')).toMatch(/gone.*no longer bundled/);
      expect(r.warnings.join('\n')).not.toMatch(/abap|yaml|apache/);
    });

    it('fails when a recorded license changes, or a clarification is unaccepted, copyleft or has no text', () => {
      const repo = shikiRepo(['rust', 'abap', 'yaml', 'apache']);
      const r = buildUiNotices({
        moduleIds: repo.ids, accepted: ACCEPTED, shiki: meta, root: repo.root, grammarLicenseDir: repo.grammarLicenseDir,
        exceptions: {
          licenses: {},
          grammars: {
            abap: { ...reviewed.grammars.abap },
            yaml: { ...reviewed.grammars.yaml, recorded: 'MIT' },
            apache: { ...reviewed.grammars.apache, license: 'LGPL-2.1-only' },
          },
        },
      });
      const errors = r.errors.join('\n');
      expect(errors).toMatch(/grammar abap: .*LicenseRef-TextMate-Bundle.*allow-list/);
      expect(errors).toMatch(/grammar yaml: .*records \(none\), not MIT/);
      expect(errors).toMatch(/grammar apache: .*copyleft/);

      const noText = shikiRepo(['yaml']);
      rmSync(join(noText.grammarLicenseDir, 'yaml.txt'));
      const r2 = buildUiNotices({ moduleIds: noText.ids, accepted: ACCEPTED, shiki: meta, root: noText.root, grammarLicenseDir: noText.grammarLicenseDir, exceptions: reviewed });
      expect(r2.errors.join('\n')).toMatch(/grammar yaml: no license text/);
    });

    it('fails on a grammar whose upstream states no license: it must be replaced or dropped', () => {
      const repo = shikiRepo(['rust', 'dax']);
      const r = buildUiNotices({
        moduleIds: repo.ids, accepted: ACCEPTED, shiki: meta, root: repo.root, grammarLicenseDir: repo.grammarLicenseDir,
        exceptions: { grammars: { dax: { recorded: '(none)', license: '(none)', source: 'https://example.invalid/dax', reason: 'r' } } },
      });
      expect(r.errors.join('\n')).toMatch(/grammar dax: .*no license.*replace it or drop it/);
    });

    describe("GitBolt's own grammar files (src/diff/grammars), replacing Shiki's", () => {
      const replaced = {
        licenses: { 'LicenseRef-TextMate-Bundle': 'permissive' },
        replaced: {
          grammars: {
            glsl: { license: 'Unlicense', source: 'https://example.invalid/sublime-glsl/GLSL.tmLanguage', reason: 'r' },
            tcl: { license: 'LicenseRef-TextMate-Bundle', source: 'https://example.invalid/tcl.tmbundle/Tcl.plist', reason: 'r' },
          },
        },
      };
      function withOwn(shikiGrammars: string[], own: string[]) {
        const repo = shikiRepo(shikiGrammars);
        writeFileSync(join(repo.grammarLicenseDir, 'glsl.txt'), 'This is free and unencumbered software released into the public domain. GLSL TEXT');
        writeFileSync(join(repo.grammarLicenseDir, 'tcl.txt'), 'TCL TEXT: Permission to copy, use, modify, sell and distribute this software is granted.');
        return { ...repo, ids: [...repo.ids, ...own.map((id) => join(repo.root, 'src', 'diff', 'grammars', `${id}.json`))] };
      }
      const accepted = [...ACCEPTED, 'Unlicense'];

      it('lists each with its license, source and text', () => {
        const repo = withOwn(['rust'], ['glsl', 'tcl']);
        const r = buildUiNotices({ moduleIds: repo.ids, accepted, exceptions: replaced, shiki: meta, root: repo.root, grammarLicenseDir: repo.grammarLicenseDir });
        expect(r.errors).toEqual([]);
        expect(r.warnings).toEqual([]);
        const t = r.text;
        expect(t).toMatch(/Grammars \(3\):/);
        expect(t).toMatch(/glsl +Unlicense +https:\/\/example\.invalid\/sublime-glsl\/GLSL\.tmLanguage +\(GitBolt's copy, src\/diff\/grammars\/glsl\.json, in place of Shiki's\)/);
        expect(t).toMatch(/tcl +LicenseRef-TextMate-Bundle +https:\/\/example\.invalid\/tcl\.tmbundle\/Tcl\.plist/);
        expect(t).toMatch(/glsl \(Unlicense\), from https:\/\/example\.invalid\/sublime-glsl\/GLSL\.tmLanguage[\s\S]*GLSL TEXT/);
        expect(t).toMatch(/tcl \(LicenseRef-TextMate-Bundle\), from [^\n]*\n-+\nTCL TEXT/);
        expect(t).toMatch(/LicenseRef-TextMate-Bundle: permissive/);
      });

      it("fails on one with no license recorded, a license outside the lists, no text, or Shiki's copy bundled too", () => {
        const repo = withOwn(['rust', 'glsl'], ['glsl', 'tcl', 'mystery']);
        rmSync(join(repo.grammarLicenseDir, 'tcl.txt'));
        const r = buildUiNotices({
          moduleIds: repo.ids, accepted, shiki: { ...meta, grammars: [...meta.grammars, { name: 'glsl', source: 'https://example.invalid/glsl' }] },
          root: repo.root, grammarLicenseDir: repo.grammarLicenseDir,
          exceptions: { ...replaced, replaced: { grammars: { ...replaced.replaced.grammars, glsl: { ...replaced.replaced.grammars.glsl, license: 'GPL-3.0' } } } },
        });
        const errors = r.errors.join('\n');
        expect(errors).toMatch(/grammar mystery: GitBolt's own grammar file src\/diff\/grammars\/mystery\.json has no license recorded/);
        expect(errors).toMatch(/grammar glsl: .*GPL-3\.0.*copyleft/);
        expect(errors).toMatch(/grammar tcl: no license text/);
        expect(errors).toMatch(/grammar glsl: replaced by src\/diff\/grammars\/glsl\.json, but Shiki's is bundled/);

        const r2 = buildUiNotices({ moduleIds: repo.ids, accepted: ACCEPTED, shiki: meta, root: repo.root, grammarLicenseDir: repo.grammarLicenseDir, exceptions: { replaced: replaced.replaced } });
        expect(r2.errors.join('\n')).toMatch(/grammar glsl: Unlicense is neither in the allow-list nor in the licenses/);
      });
    });
  });

  it('the real exceptions match tm-grammars and tm-themes, and every clarified license has its text', async () => {
    const root = process.cwd();
    const exceptions = JSON.parse(readFileSync(join(root, 'build', 'license-exceptions.json'), 'utf8')) as Exceptions;
    const { grammars } = (await import(join(root, 'node_modules', 'tm-grammars', 'index.js'))) as { grammars: { name: string; license?: string }[] };
    const { themes } = (await import(join(root, 'node_modules', 'tm-themes', 'index.js'))) as { themes: { name: string; license?: string }[] };
    const notice = readFileSync(join(root, 'node_modules', 'tm-grammars', 'NOTICE'), 'utf8');
    for (const [id, c] of Object.entries(exceptions.grammars ?? {})) {
      const m = grammars.find((g) => g.name === id);
      expect(m, id).toBeDefined();
      expect(c.recorded, id).toBe(m!.license || '(none)');
      expect(c.license, `${id}: a license upstream states (replace or drop a grammar with none)`).not.toBe('(none)');
      const inNotice = new RegExp(`^Files:.*(\\s|,)${id}\\.json(,|$)`, 'm').test(notice);
      expect(inNotice || existsSync(join(root, 'build', 'grammar-licenses', `${id}.txt`)), `${id}: license text`).toBe(true);
    }
    for (const [id, license] of Object.entries(exceptions.dropped?.grammars ?? {})) expect(grammars.find((g) => g.name === id)?.license || '(none)', id).toBe(license);
    expect(Object.keys(exceptions.dropped?.grammars ?? {})).toContain('dax');
    for (const [id, c] of Object.entries(exceptions.replaced?.grammars ?? {})) {
      expect(grammars.find((g) => g.name === id), `${id}: replaces one of Shiki's grammars`).toBeDefined();
      expect(exceptions.grammars?.[id], `${id}: no clarification for Shiki's replaced copy`).toBeUndefined();
      expect(c.license, id).not.toBe('(none)');
      expect(existsSync(join(root, 'src', 'diff', 'grammars', `${id}.json`)), `${id}: grammar file`).toBe(true);
      expect(existsSync(join(root, 'build', 'grammar-licenses', `${id}.txt`)), `${id}: license text`).toBe(true);
    }
    for (const [id, license] of Object.entries(exceptions.dropped?.themes ?? {})) expect(themes.find((t) => t.name === id)?.license, id).toBe(license);
  });
});
