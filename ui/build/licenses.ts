// The UI's third-party notices (docs/licensing.md): every npm package with code in the production
// bundle (main build and workers), found from the bundle's own module list, so devDependencies
// and tree-shaken packages never appear and nothing bundled is missed. Each package is held to the
// allow-list in ../../about.toml (shared with the Rust notices); Shiki's grammars and themes,
// which come from many upstream projects, are listed and checked one by one from the tm-grammars
// and tm-themes metadata. The build writes dist/licenses/THIRD-PARTY-NOTICES-ui.txt and fails on
// a license outside the allow-list that build/license-exceptions.json doesn't name.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';

export interface Exception { license: string; reason: string }
/** A bundled grammar's or theme's license, researched upstream because tm-grammars/tm-themes
 *  record none, or NOASSERTION. */
export interface Clarification {
  /** What tm-grammars/tm-themes record ('(none)' for nothing): the build fails when that changes. */
  recorded: string;
  /** The upstream license (an SPDX expression). '(none)' (upstream states none anywhere) fails the
   *  build: such a grammar is replaced (`replaced`) or dropped. */
  license: string;
  /** Where upstream states it. */
  source: string;
  reason: string;
}
/** A grammar GitBolt ships as its own file, src/diff/grammars/<id>.json, in place of Shiki's. */
export interface Replacement {
  /** Its license (an SPDX expression): in the allow-list or `licenses`. */
  license: string;
  /** The upstream file it was converted from, at the commit used. */
  source: string;
  reason: string;
}
export interface Exceptions {
  /** A license for a package whose package.json declares none (checked against its license file by hand). */
  packages?: Record<string, Exception>;
  /** Grammars and themes left out of the bundle for their licenses (id → license): bundling one fails. */
  dropped?: { grammars?: Record<string, string>; themes?: Record<string, string> };
  /** Reviewed permissive licenses outside the allow-list that a clarified grammar or theme may use. */
  licenses?: Record<string, string>;
  grammars?: Record<string, Clarification>;
  themes?: Record<string, Clarification>;
  /** Grammars replaced by GitBolt's own files (src/diff/grammars/<id>.json): bundling Shiki's copy fails. */
  replaced?: { grammars?: Record<string, Replacement> };
}
export interface ShikiItem { name: string; license?: string; source?: string; aliases?: string[] }
export interface ShikiMeta { grammars: ShikiItem[]; themes: ShikiItem[] }

/** The `accepted = [...]` list of cargo-about's about.toml, in order. */
export function acceptedFromAboutToml(toml: string): string[] {
  const m = /^accepted\s*=\s*\[([\s\S]*?)\]/m.exec(toml);
  if (!m) throw new Error('about.toml has no accepted = [...] list');
  return [...m[1].replace(/#.*$/gm, '').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** The licenses an SPDX expression is used under: for OR the alternative earliest in `accepted`,
 *  for AND every part. Null when no choice is fully accepted. */
export function chooseLicense(expr: string, accepted: string[]): string[] | null {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const rank = (ids: string[]) => Math.min(...ids.map((id) => accepted.indexOf(id)));
  // Each alternative is a list of licenses that must all be accepted; null = not accepted.
  function parseOr(): string[][] {
    const alts = parseAnd();
    while (tokens[i] === 'OR') { i++; alts.push(...parseAnd()); }
    return alts;
  }
  function parseAnd(): string[][] {
    let alts = parseAtom();
    while (tokens[i] === 'AND') {
      i++;
      const right = parseAtom();
      alts = alts.flatMap((a) => right.map((b) => [...a, ...b]));
    }
    return alts;
  }
  function parseAtom(): string[][] {
    const t = tokens[i++];
    if (t === '(') { const r = parseOr(); i++; return r; }
    if (t === undefined) return [['(no license)']];
    let id = t;
    if (tokens[i] === 'WITH') { id = `${t} WITH ${tokens[i + 1]}`; i += 2; }
    return [[id]];
  }
  if (!tokens.length) return null;
  const alts = parseOr().filter((a) => a.every((id) => accepted.includes(id)));
  if (!alts.length || i < tokens.length) return null;
  alts.sort((a, b) => rank(a) - rank(b));
  return [...new Set(alts[0])];
}

/** The node_modules package a bundled module belongs to, or null (our own code, virtual modules). */
export function packageDirOf(id: string): { dir: string; name: string } | null {
  const path = id.replace(/^\0/, '').replace(/[?#].*$/, '').replace(/\\/g, '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = path.slice(at + '/node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return { dir: path.slice(0, at + '/node_modules/'.length) + name, name };
}

const COPYRIGHT = /^(copyright\b|\(c\)\s|©)/i;
const NOT_COPYRIGHT = /\[yyyy\]|<year>|\{yyyy\}|\[name of copyright owner\]|^copyright\s+(notice|holders?|owner|license|and\b|law)/i;
const asCopyright = (line: string) => {
  const s = line.trim().replace(/^[#*/;\- ]+/, '').trim();
  return COPYRIGHT.test(s) && !NOT_COPYRIGHT.test(s) && s.length < 300 ? s : null;
};

export function copyrightLines(text: string): string[] {
  return text.split(/\r?\n/).map(asCopyright).filter((c): c is string => !!c);
}

function withoutCopyright(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').filter((l) => !asCopyright(l)).map((l) => l.trimEnd()).join('\n')
    .replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n');
}

/** Texts that differ only in copyright lines, a title line, wrapping or punctuation are one. */
function textKey(text: string): string {
  let lines = withoutCopyright(text).split('\n').filter((l) => l.trim());
  if (lines.length && lines[0].length < 60 && /licen[cs]e/i.test(lines[0]) && !lines[0].trimEnd().endsWith('.')) lines = lines.slice(1);
  return lines.join(' ').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([-._ ].*)?$/i;
const NOTICE_FILE = /^(notice|third[-_ ]?party[-_ ]?notices)([-._ ].*)?$/i;
const NOT_TEXT = /\.(spdx|json|js|mjs|cjs|ts|html?)$/i;

function readText(dir: string, f: string): string | null {
  const p = join(dir, f);
  try {
    return statSync(p).isFile() ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

/** A package's license texts for the licenses it's used under: with several files, those named
 *  for a chosen license, else all but those named for another one (LICENSE-MPL when Apache-2.0
 *  is used). */
function licenseTexts(dir: string, chosen: string[]): string[] {
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && !NOT_TEXT.test(f)).sort();
  const token = (id: string) => id.toLowerCase().split(/[-.\s]/)[0];
  const wanted = chosen.map(token);
  const named = (f: string) => ['mit', 'apache', 'bsd', 'isc', 'mpl', 'zlib', 'cc0', 'unicode', 'ofl', 'bsl'].filter((t) => f.toLowerCase().includes(t));
  let pick = files;
  if (files.length > 1) {
    const match = files.filter((f) => named(f).some((t) => wanted.includes(t)));
    pick = match.length ? match : files.filter((f) => !named(f).length);
    if (!pick.length) pick = files;
  }
  return pick.map((f) => readText(dir, f)).filter((t): t is string => !!t?.trim());
}

interface Group { packages: Map<string, string[] | { none: string }>; texts: { key: string; text: string; users: Set<string> }[] }

function render(groups: Map<string, Group>, extra: string[]): string {
  const order = [...groups.keys()].sort((a, b) => groups.get(b)!.packages.size - groups.get(a)!.packages.size || a.localeCompare(b));
  const width = Math.max(10, ...order.map((l) => l.length));
  const title = 'GitBolt: third-party notices for the UI';
  const out = [
    title, '='.repeat(title.length), '',
    "GitBolt's interface bundles the npm packages below. Each package is listed under the license\n" +
      'GitBolt uses it under, with the copyright lines from its license files; the full text of each\n' +
      "license follows its list. Shiki's grammars and themes, and notices the packages ship, come\n" +
      'after. Generated by the UI build (ui/build/licenses.ts) from the modules in the bundle.',
    '', 'Summary', '-------',
    ...order.map((l) => `  ${l.padEnd(width)}  ${String(groups.get(l)!.packages.size).padStart(4)}`),
    '',
  ];
  for (const lid of order) {
    const g = groups.get(lid)!;
    const n = g.packages.size;
    out.push('', '='.repeat(100), `${lid} (${n} package${n === 1 ? '' : 's'})`, '='.repeat(100), '');
    for (const label of [...g.packages.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      out.push(label);
      const lines = g.packages.get(label)!;
      if (Array.isArray(lines) && lines.length) out.push(...lines.map((c) => `  ${c}`));
      else out.push(`  (${Array.isArray(lines) ? 'no copyright line in its license file' : 'no license file in the package'}${!Array.isArray(lines) && lines.none ? `; author: ${lines.none}` : ''})`);
    }
    const texts = [...g.texts].sort((a, b) => b.users.size - a.users.size || a.key.localeCompare(b.key));
    texts.forEach((t, i) => {
      let head = `--- ${lid} license text`;
      if (texts.length > 1) head += ` (${i + 1} of ${texts.length}; used by ${[...t.users].sort().join(', ')})`;
      out.push('', `${head} ---`, '', t.text, '');
    });
  }
  out.push(...extra);
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

function authorName(a: unknown): string {
  const s = typeof a === 'string' ? a : a && typeof a === 'object' && 'name' in a ? String((a as { name: unknown }).name) : '';
  return s.replace(/\s*[<(][^>)]*[>)]/g, '').trim();
}

function declaredLicense(pkg: Record<string, unknown>): string {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ');
  if (l && typeof l === 'object' && 'type' in l) return String((l as { type: unknown }).type);
  return '';
}

export interface UiNotices { text: string; errors: string[]; warnings: string[]; counts: Record<string, number> }

/** GitBolt's own grammar files, in place of Shiki's (build/license-exceptions.json `replaced`). */
const OWN_GRAMMAR = /\/src\/diff\/grammars\/([^/]+)\.json$/;
const ownGrammarFile = (id: string) => `src/diff/grammars/${id}.json`;

/** GPL, LGPL and AGPL (tm-grammars records one grammar's as plain "GNU"): a grammar or theme under
 *  one is never bundled, whatever the exceptions say. */
export const isCopyleft = (license: string): boolean => /\b[AL]?GPL\b|\bGNU\b/i.test(license);

/** A tm-grammars/tm-themes NOTICE: its header, then one section per upstream license, each with
 *  the grammar or theme ids its `Files:` line names. */
function noticeSections(text: string): { head: string; sections: { ids: string[]; text: string }[] } {
  const parts = text.replace(/\r\n/g, '\n').split(/^={20,}\n/m);
  const head = parts.shift()!.trim();
  return {
    head,
    sections: parts.map((p) => ({
      ids: (/^Files:\s*(.*)$/m.exec(p)?.[1] ?? '').split(',').map((f) => f.trim().replace(/\.json$/, '')).filter(Boolean),
      text: p.trim(),
    })),
  };
}

export function buildUiNotices(opts: {
  moduleIds: Iterable<string>; accepted: string[]; exceptions: Exceptions; shiki?: ShikiMeta; root?: string;
  /** `<id>.txt`: the upstream license text of a clarified grammar or theme. */
  grammarLicenseDir?: string;
}): UiNotices {
  const { accepted, exceptions } = opts;
  const errors: string[] = [];
  const warnings: string[] = [];
  const pkgs = new Map<string, string>(); // dir -> name
  const grammarIds = new Set<string>();
  const themeIds = new Set<string>();
  const ownGrammarIds = new Set<string>();
  for (const id of opts.moduleIds) {
    const own = OWN_GRAMMAR.exec(id.replace(/^\0/, '').replace(/[?#].*$/, '').replace(/\\/g, '/'));
    if (own) ownGrammarIds.add(own[1]);
    // The bundler's own helpers are virtual modules: \0vite/preload-helper.js, \0rolldown/runtime.js.
    const helper = /^\0(vite|rolldown)\//.exec(id);
    const p = helper && opts.root ? { dir: join(opts.root, 'node_modules', helper[1]), name: helper[1] } : packageDirOf(id);
    if (!p) continue;
    pkgs.set(p.dir, p.name);
    const file = id.replace(/[?#].*$/, '').split('/').pop()!.replace(/\.mjs$/, '');
    if (p.name === '@shikijs/langs' && /\/dist\/[^/]+\.mjs/.test(id) && file !== 'index') grammarIds.add(file);
    if (p.name === '@shikijs/themes' && /\/dist\/[^/]+\.mjs/.test(id) && file !== 'index') themeIds.add(file);
  }

  const groups = new Map<string, Group>();
  const counts: Record<string, number> = {};
  const notices: string[] = [];
  for (const [dir, name] of [...pkgs].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      errors.push(`${name}: no package.json in ${dir}`);
      continue;
    }
    const label = `${name} ${pkg.version ?? '?'}`;
    const declared = declaredLicense(pkg) || exceptions.packages?.[name]?.license || '';
    const chosen = chooseLicense(declared, accepted);
    if (!chosen) {
      errors.push(`${label}: ${declared || '(no license)'}`);
      continue;
    }
    const texts = licenseTexts(dir, chosen);
    for (const lid of chosen) {
      counts[lid] = (counts[lid] ?? 0) + 1;
      const g: Group = groups.get(lid) ?? { packages: new Map(), texts: [] };
      groups.set(lid, g);
      const lines = [...new Set(texts.flatMap(copyrightLines))];
      g.packages.set(label, texts.length ? lines : { none: authorName(pkg.author) });
      for (const text of texts) {
        const key = textKey(text);
        const same = g.texts.find((t) => t.key === key);
        if (same) same.users.add(label);
        else g.texts.push({ key, text: withoutCopyright(text), users: new Set([label]) });
      }
    }
    for (const f of readdirSync(dir).filter((f) => NOTICE_FILE.test(f) && !NOT_TEXT.test(f)).sort()) {
      const t = readText(dir, f);
      if (t?.trim()) notices.push('', '='.repeat(100), `Notices shipped by ${label} (${f})`, '='.repeat(100), '', t.trim(), '');
    }
  }

  const extra: string[] = [];
  if (opts.shiki && (grammarIds.size || themeIds.size || ownGrammarIds.size)) {
    const extraLicenses = exceptions.licenses ?? {};
    const usedLicenses = new Set<string>();
    const texts: { label: string; text: string }[] = [];
    const tmNotices = new Map<'grammar' | 'theme', ReturnType<typeof noticeSections> | null>();
    for (const kind of ['grammar', 'theme'] as const) {
      const t = opts.root ? readText(join(opts.root, 'node_modules', `tm-${kind}s`), 'NOTICE') : null;
      if (!t) errors.push(`tm-${kind}s: no NOTICE file (is the tm-${kind}s devDependency installed?)`);
      tmNotices.set(kind, t ? noticeSections(t) : null);
    }
    const replaced = exceptions.replaced?.grammars ?? {};
    const section = (kind: 'grammar' | 'theme', ids: Set<string>, meta: ShikiItem[], reviewed: Record<string, Clarification> = {}, dropped: Record<string, string> = {}) => {
      const byName = new Map(meta.map((m) => [m.name, m]));
      const aliases = new Set(meta.flatMap((m) => m.aliases ?? []));
      const inNotice = new Set(tmNotices.get(kind)?.sections.flatMap((s) => s.ids));
      const rows: string[][] = [];
      const used = new Set<string>();
      for (const id of [...ids].sort()) {
        if (Object.hasOwn(dropped, id)) errors.push(`${kind} ${id}: dropped from the bundle (build/license-exceptions.json) for its license, ${dropped[id]}, but bundled`);
        if (kind === 'grammar' && Object.hasOwn(replaced, id)) errors.push(`${kind} ${id}: replaced by ${ownGrammarFile(id)}, but Shiki's is bundled`);
        const m = byName.get(id);
        if (!m) {
          if (!aliases.has(id)) errors.push(`${kind} ${id}: not in the tm-${kind}s metadata (update tm-${kind}s to the version Shiki was built from)`);
          continue;
        }
        const recorded = m.license || '(none)';
        const row = [id, m.license || '(no license)', m.source ?? '', ''];
        if (isCopyleft(recorded)) {
          errors.push(`${kind} ${id}: ${recorded}, a copyleft license: copyleft grammars and themes are never bundled (drop it, see docs/licensing.md)`);
        } else if (!chooseLicense(m.license ?? '', accepted)) {
          const c = reviewed[id];
          if (c) used.add(id);
          if (!c) {
            errors.push(`${kind} ${id}: ${row[1]}`);
          } else if (c.recorded !== recorded) {
            errors.push(`${kind} ${id}: tm-${kind}s records ${recorded}, not ${c.recorded} as build/license-exceptions.json says (review its license again)`);
          } else if (c.license === '(none)') {
            errors.push(`${kind} ${id}: its upstream states no license: replace it or drop it (docs/licensing.md)`);
          } else if (isCopyleft(c.license)) {
            errors.push(`${kind} ${id}: upstream license ${c.license} is copyleft: drop it from the bundle (docs/licensing.md)`);
          } else if (!chooseLicense(c.license, [...accepted, ...Object.keys(extraLicenses)])) {
            errors.push(`${kind} ${id}: upstream license ${c.license} is neither in the allow-list nor in the licenses of build/license-exceptions.json`);
          } else {
            row.splice(1, 3, c.license, c.source, `tm-${kind}s records ${m.license || 'no license'}`);
            for (const l of Object.keys(extraLicenses)) if (c.license.includes(l)) usedLicenses.add(l);
            const text = opts.grammarLicenseDir ? readText(opts.grammarLicenseDir, `${id}.txt`) : null;
            if (text?.trim()) texts.push({ label: `${id} (${c.license}), from ${c.source}`, text: text.trim() });
            else if (!inNotice.has(id)) errors.push(`${kind} ${id}: no license text (add build/grammar-licenses/${id}.txt)`);
          }
        }
        rows.push(row);
      }
      const stale = Object.keys(reviewed).filter((id) => !used.has(id));
      if (stale.length) warnings.push(`${kind} exceptions ${stale.join(', ')}: no longer bundled or no longer needed (remove them from build/license-exceptions.json)`);
      return rows;
    };
    const table = (rows: string[][]) => {
      const w = [0, 1].map((i) => Math.max(0, ...rows.map((r) => r[i].length)));
      return rows.map(([id, lic, src, note]) => `  ${id.padEnd(w[0])}  ${lic.padEnd(w[1])}  ${src}${note ? `  (${note})` : ''}`.trimEnd());
    };
    // GitBolt's own grammar files: each needs its license recorded in `replaced`, and its text.
    const ownRows = [...ownGrammarIds].sort().flatMap((id) => {
      const c = replaced[id];
      if (!c) {
        errors.push(`grammar ${id}: GitBolt's own grammar file ${ownGrammarFile(id)} has no license recorded (add it to replaced.grammars in build/license-exceptions.json)`);
        return [];
      }
      if (isCopyleft(c.license)) {
        errors.push(`grammar ${id}: ${c.license}, a copyleft license: copyleft grammars are never bundled`);
        return [];
      }
      if (!chooseLicense(c.license, [...accepted, ...Object.keys(extraLicenses)])) {
        errors.push(`grammar ${id}: ${c.license} is neither in the allow-list nor in the licenses of build/license-exceptions.json`);
        return [];
      }
      for (const l of Object.keys(extraLicenses)) if (c.license.includes(l)) usedLicenses.add(l);
      const text = opts.grammarLicenseDir ? readText(opts.grammarLicenseDir, `${id}.txt`) : null;
      if (text?.trim()) texts.push({ label: `${id} (${c.license}), from ${c.source}`, text: text.trim() });
      else errors.push(`grammar ${id}: no license text (add build/grammar-licenses/${id}.txt)`);
      return [[id, c.license, c.source, `GitBolt's copy, ${ownGrammarFile(id)}, in place of Shiki's`]];
    });
    const staleOwn = Object.keys(replaced).filter((id) => !ownGrammarIds.has(id));
    if (staleOwn.length) warnings.push(`replaced grammars ${staleOwn.join(', ')}: not bundled (remove them from build/license-exceptions.json)`);
    const shikiGrammarRows = section('grammar', grammarIds, opts.shiki.grammars, exceptions.grammars, exceptions.dropped?.grammars);
    const grammarRows = table([...shikiGrammarRows, ...ownRows].sort((a, b) => a[0].localeCompare(b[0])));
    const themeRows = table(section('theme', themeIds, opts.shiki.themes, exceptions.themes, exceptions.dropped?.themes));
    extra.push('', '='.repeat(100), "Shiki's grammars and themes", '='.repeat(100), '',
      "Shiki's grammars (@shikijs/langs) and themes (@shikijs/themes) are converted from many upstream\n" +
        'projects, each under its own license. Every grammar and theme in the bundle, its license and its\n' +
        'source: as the tm-grammars and tm-themes projects record them, or, where those record none, as\n' +
        'found upstream (the note says so). Where upstream states no license at all, GitBolt ships its own\n' +
        'grammar file converted from a permissively licensed project instead (the note says so), or leaves\n' +
        'the language out (plain text).', '',
      `Grammars (${grammarRows.length}):`, ...grammarRows, '', `Themes (${themeRows.length}):`, ...themeRows);
    if (usedLicenses.size) {
      extra.push('', 'Licenses used above that are outside the allow-list (reviewed; all permissive):', ...[...usedLicenses].sort().map((l) => `  ${l}: ${extraLicenses[l]}`));
    }
    if (texts.length) {
      // Identical texts (the TextMate bundles' license, say) once, with every grammar that uses it.
      const byText = new Map<string, string[]>();
      for (const t of texts) byText.set(t.text, [...(byText.get(t.text) ?? []), t.label]);
      extra.push('', '='.repeat(100), "The upstream license texts of the grammars and themes above whose license tm-grammars or\ntm-themes don't record, and of GitBolt's own grammar files", '='.repeat(100));
      for (const [text, labels] of byText) extra.push('', ...labels, '-'.repeat(100), text);
    }
    for (const [kind, ids] of [['grammar', grammarIds], ['theme', themeIds]] as const) {
      const n = tmNotices.get(kind);
      if (!n) continue;
      const kept = n.sections.filter((s) => s.ids.some((id) => ids.has(id)));
      extra.push('', '='.repeat(100), `The upstream license texts of the ${kind}s (the NOTICE file of tm-${kind}s, for the bundled ones)`, '='.repeat(100), '',
        n.head, ...kept.flatMap((s) => ['', '='.repeat(100), s.text]), '');
    }
  }
  extra.push(...notices);
  return { text: render(groups, extra), errors, warnings, counts };
}

/** tm-grammars' and tm-themes' metadata (their index.js), when Shiki is installed. */
async function loadShikiMeta(root: string): Promise<ShikiMeta | undefined> {
  const index = (pkg: string) => join(root, 'node_modules', pkg, 'index.js');
  if (!existsSync(index('tm-grammars')) || !existsSync(index('tm-themes'))) return undefined;
  const g = (await import(pathToFileURL(index('tm-grammars')).href)) as { grammars: ShikiItem[]; injections?: ShikiItem[] };
  const t = (await import(pathToFileURL(index('tm-themes')).href)) as { themes: ShikiItem[] };
  return { grammars: [...g.grammars, ...(g.injections ?? [])], themes: t.themes };
}

/** The bundled grammars must be the ones tm-grammars describes (same version): compares the
 *  rules of each grammar module with tm-grammars' copy. */
function checkGrammarVersion(root: string, ids: Iterable<string>): string[] {
  const errors: string[] = [];
  for (const id of ids) {
    const p = packageDirOf(id);
    if (p?.name !== '@shikijs/langs') continue;
    const name = id.replace(/[?#].*$/, '').split('/').pop()!.replace(/\.mjs$/, '');
    const ours = join(root, 'node_modules', 'tm-grammars', 'grammars', `${name}.json`);
    if (name === 'index' || !existsSync(ours)) continue;
    const m = /JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(readFileSync(id.replace(/^\0/, '').replace(/[?#].*$/, ''), 'utf8'));
    if (!m) continue;
    const a = JSON.parse(JSON.parse(m[1]) as string) as { patterns?: unknown };
    const b = JSON.parse(readFileSync(ours, 'utf8')) as { patterns?: unknown };
    if (JSON.stringify(a.patterns) !== JSON.stringify(b.patterns)) errors.push(name);
  }
  return errors.length
    ? [`tm-grammars doesn't match the grammars @shikijs/langs bundles (${errors.slice(0, 5).join(', ')}${errors.length > 5 ? ', …' : ''}): pin the tm-grammars and tm-themes devDependencies to the versions this Shiki release was built from`]
    : [];
}

/** The Vite plugins: `main` for the app build, `worker()` for each worker build (their modules
 *  count too). The main build's generateBundle runs after the workers are bundled. */
export function licenseNotices(opts: { root: string; aboutToml: string; exceptions: string; extraFiles: { name: string; path: string }[] }) {
  const ids = new Set<string>();
  const collect = (bundle: Record<string, { type: string; moduleIds?: readonly string[] }>) => {
    for (const out of Object.values(bundle)) if (out.type === 'chunk') for (const id of out.moduleIds ?? []) ids.add(id);
  };
  const main: Plugin = {
    name: 'gitbolt-license-notices',
    apply: 'build',
    async generateBundle(_options, bundle) {
      collect(bundle as never);
      const accepted = acceptedFromAboutToml(readFileSync(opts.aboutToml, 'utf8'));
      const exceptions = JSON.parse(readFileSync(opts.exceptions, 'utf8')) as Exceptions;
      const shiki = await loadShikiMeta(opts.root);
      const r = buildUiNotices({ moduleIds: ids, accepted, exceptions, shiki, root: opts.root, grammarLicenseDir: join(opts.root, 'build', 'grammar-licenses') });
      if (shiki) r.errors.push(...checkGrammarVersion(opts.root, ids));
      for (const w of r.warnings) this.warn(w);
      if (r.errors.length) {
        this.error(`licenses: bundled packages under a license outside the allow-list in about.toml, or unclear (see docs/licensing.md):\n  ${r.errors.join('\n  ')}`);
      }
      const files: { name: string; size: number }[] = [];
      const emit = (name: string, source: string | Uint8Array) => {
        this.emitFile({ type: 'asset', fileName: `licenses/${name}`, source });
        files.push({ name, size: typeof source === 'string' ? Buffer.byteLength(source) : source.length });
      };
      emit('THIRD-PARTY-NOTICES-ui.txt', r.text);
      for (const f of opts.extraFiles) if (existsSync(f.path)) emit(f.name, readFileSync(f.path));
      this.emitFile({ type: 'asset', fileName: 'licenses/index.json', source: JSON.stringify({ files }) });
      this.info?.(`licenses: ${Object.entries(r.counts).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ')}`);
    },
  };
  const worker = (): Plugin => ({ name: 'gitbolt-license-notices-worker', apply: 'build', generateBundle(_o, bundle) { collect(bundle as never); } });
  return { main, worker };
}
