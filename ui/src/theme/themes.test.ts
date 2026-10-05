import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveColors } from './apply';
import { contrastRatio } from './contrast';
import { COLOR_TOKENS, DEFAULT_THEME_ID, isThemeId, SHIKI_BUNDLED_THEMES, THEME_IDS, THEMES } from './themes';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

/** Every custom property declared in tokens.css's top-level `:root` blocks (not the reduced-motion one). */
function rootDeclarations(): Record<string, string> {
  const css = readFileSync(join(SRC, 'theme', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
  const out: Record<string, string> = {};
  for (const block of topLevel.matchAll(/(?<=^|\})\s*:root\s*\{([^}]*)\}/g)) {
    for (const m of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  }
  return out;
}

const luminance = (hex: string) => contrastRatio(hex, '#000000') * 0.05 - 0.05;

describe('themes', () => {
  it('has exactly the ten built-in themes of spec §12.1, in menu order', () => {
    expect(THEME_IDS).toEqual(['default-dark', 'light', 'monokai', 'darcula', 'dracula', 'one-dark', 'solarized-dark', 'solarized-light', 'github-dark', 'nord']);
    for (const id of THEME_IDS) expect(THEMES[id].id).toBe(id);
    expect(DEFAULT_THEME_ID).toBe('default-dark');
    expect(isThemeId('nord')).toBe(true);
    expect(isThemeId('solarized')).toBe(false);
  });

  it('pairs each theme with the editor theme named in spec §12.1 (GitHub Dark: github-dark-default, R5)', () => {
    const pairs = Object.fromEntries(THEME_IDS.map((id) => [id, THEMES[id].editorTheme]));
    expect(pairs).toEqual({
      'default-dark': 'dark-plus', light: 'light-plus', monokai: 'monokai', darcula: 'darcula', dracula: 'dracula',
      'one-dark': 'one-dark-pro', 'solarized-dark': 'solarized-dark', 'solarized-light': 'solarized-light',
      'github-dark': 'github-dark-default', nord: 'nord',
    });
    for (const id of THEME_IDS) expect([...SHIKI_BUNDLED_THEMES, 'darcula']).toContain(THEMES[id].editorTheme);
  });

  it.each(THEME_IDS)('%s defines every color token and ten hex lane colors', (id) => {
    const t = THEMES[id];
    expect(Object.keys(t.colors).sort()).toEqual([...COLOR_TOKENS].sort());
    expect(t.graph).toHaveLength(10);
    for (const c of t.graph) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    for (const [k, v] of Object.entries(t.colors)) expect(v, k).toMatch(/^#[0-9a-f]{6}$|^rgba\(\d+, \d+, \d+, [\d.]+\)$/);
  });

  it.each(THEME_IDS)('%s kind matches its background', (id) => {
    const t = THEMES[id];
    expect(luminance(t.colors['app-bg0']) > 0.4 ? 'light' : 'dark').toBe(t.kind);
  });

  it.each(THEME_IDS)('%s text is readable on its backgrounds', (id) => {
    const c = THEMES[id].colors;
    for (const bg of ['app-bg0', 'panel-bg0', 'panel-bg1', 'action-bar-bg', 'tab-bar-bg', 'file-bar-bg', 'toolbar-bg0'] as const) {
      expect(contrastRatio(c['text-normal'], c[bg]), `text-normal on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(c['text-secondary'], c['app-bg0'])).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(c['text-disabled'], c['app-bg0'])).toBeGreaterThanOrEqual(2);
    expect(contrastRatio(c['node-text'], c['node-fill'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c['text-selected'], c['checked-out-row']), 'the checked-out row').toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c['text-normal'], c['selection-bg']), 'selected text').toBeGreaterThanOrEqual(3);
    expect(contrastRatio(c['count-blue'], c['panel-bg0']), 'sidebar counts').toBeGreaterThanOrEqual(3);
  });

  it.each(THEME_IDS)('%s accents carry their text and totals', (id) => {
    const c = THEMES[id].colors;
    // Default Dark's own white on #4d88ff is 3.3:1, so 3:1 (WCAG's UI-component floor) is the bar.
    expect(contrastRatio(c['text-on-accent'], c.blue), 'a primary button').toBeGreaterThanOrEqual(3);
    expect(contrastRatio(c['text-on-accent'], c['status-deleted']), "the bell's badge").toBeGreaterThanOrEqual(3);
    expect(contrastRatio(c['text-on-accent'], c['checked-out']), 'the check box').toBeGreaterThanOrEqual(3);
    expect(contrastRatio(c['stats-added-bright'], c['panel-bg0']), '+ totals').toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c['stats-deleted-bright'], c['panel-bg0']), '− totals').toBeGreaterThanOrEqual(4.5);
    // The selection must show on every surface text is selected on.
    for (const bg of ['app-bg0', 'panel-bg0', 'panel-bg1'] as const) expect(c['selection-bg'], bg).not.toBe(c[bg]);
  });

  it.each(THEME_IDS)('%s lane colors stand out from the background', (id) => {
    // Default Dark's own darkest lane (#8e00c2) is 2.33:1, so 2:1 is the floor.
    for (const g of THEMES[id].graph) expect(contrastRatio(g, THEMES[id].colors['app-bg0'])).toBeGreaterThanOrEqual(2);
  });

  it.each(THEME_IDS)('%s file-status icons and avatar initials read at 3:1 (WCAG non-text)', (id) => {
    const t = THEMES[id];
    for (const k of ['status-added', 'status-modified', 'status-deleted', 'status-renamed', 'status-conflicted'] as const) {
      expect(contrastRatio(t.colors[k], t.colors['panel-bg0']), k).toBeGreaterThanOrEqual(3);
    }
    // Default Dark keeps white initials on every lane, its 1.6:1 yellow included (1C).
    if (id === 'default-dark') return;
    const r = resolveColors(t);
    r.graph.forEach((g, i) => expect(contrastRatio(r.laneText[i], g), `initials on lane ${i} ${g}`).toBeGreaterThanOrEqual(3));
  });

  it("Default Dark is exactly 1C's dark theme, every token (tokens.css at 5b5fa4e, the user's K32-K65 samples)", () => {
    // One literal copy of the whole theme, so no edit to themes.ts or tokens.css can drift the
    // hand-tuned look, and no token can go unpinned. The literals the CSS used to hard-code are here too.
    expect(THEMES['default-dark']).toEqual({
      id: 'default-dark', label: 'Default Dark', kind: 'dark', editorTheme: 'dark-plus', laneText: '#ffffff',
      graph: ['#15a0bf', '#0669f7', '#8e00c2', '#c517b6', '#d90171', '#cd0101', '#f25d2e', '#f2ca33', '#7bd938', '#2ece9d'],
      colors: {
        'app-bg0': '#1c1e23', 'panel-bg0': '#262930', 'panel-bg1': '#30343c', 'toolbar-bg0': '#2a2e36',
        'action-bar-bg': '#33373f', 'tab-bar-bg': '#1f2228', 'file-bar-bg': '#272a31',
        'text-selected': '#ffffff', 'text-normal': 'rgba(255, 255, 255, 0.75)', 'text-secondary': 'rgba(255, 255, 255, 0.6)', 'text-disabled': 'rgba(255, 255, 255, 0.4)',
        'text-on-accent': '#ffffff',
        'stats-added': '#347d39', 'stats-deleted': '#c93c37',
        red: '#d9413d', orange: '#de9b43', yellow: '#ecb91c', green: '#5cb85c', blue: '#4d88ff', link: '#40c5ec',
        'count-blue': '#6d9deb', 'checked-out-row': '#37563e', 'checked-out': '#457c4a', 'selection-bg': '#264f78',
        'conflict-ours': '#15a0bf', 'conflict-theirs': '#f2ca33', 'conflict-base': '#c517b6',
        'wip-input-bg': '#16181c', 'wip-input-border': '#282a2d', 'wip-input-placeholder': '#6e6f71',
        'hover-row': 'rgba(77, 136, 255, 0.1)', 'selected-row': 'rgba(77, 136, 255, 0.2)', 'section-border': 'rgba(255, 255, 255, 0.08)', 'focus-outline': 'rgba(77, 136, 255, 0.6)',
        'text-row-dimmed': 'rgba(255, 255, 255, 0.2)', 'text-row-dimmed-branch': 'rgba(255, 255, 255, 0.5)', 'sidebar-icon': 'rgba(255, 255, 255, 0.45)',
        'stats-added-bright': '#5cb85c', 'stats-deleted-bright': '#f0625d',
        'status-added': '#5cb85c', 'status-modified': '#de9b43', 'status-deleted': '#d9413d', 'status-renamed': '#4d88ff', 'status-conflicted': '#b56ee6',
        'scroll-thumb-bg': 'rgba(255, 255, 255, 0.15)', 'scroll-thumb-hover-bg': 'rgba(255, 255, 255, 0.25)',
        'control-bg': 'rgba(255, 255, 255, 0.06)', 'control-hover-bg': 'rgba(255, 255, 255, 0.12)', 'image-frame-border': 'rgba(255, 255, 255, 0.22)',
        'shadow-modal': 'rgba(0, 0, 0, 0.5)', 'shadow-popup': 'rgba(0, 0, 0, 0.45)', 'shadow-tooltip': 'rgba(0, 0, 0, 0.4)', backdrop: 'rgba(0, 0, 0, 0.45)',
        'node-fill': '#1c1e23', 'node-text': '#ffffff', 'collapse-strip': 'rgba(0, 0, 0, 0.4)',
        'conflict-ours-tick': '#1c1e23', 'conflict-theirs-tick': '#1c1e23',
        'diff-inserted-text': 'rgba(92, 184, 92, 0.12)', 'diff-removed-text': 'rgba(217, 65, 61, 0.2)',
        'diff-inserted-line': 'rgba(92, 184, 92, 0.1)', 'diff-removed-line': 'rgba(217, 65, 61, 0.15)',
        'diff-diagonal-fill': 'rgba(204, 204, 204, 0.2)',
        'forge-gitlab': '#e2432a', 'forge-github': '#6e5494', purple: '#a371f7',
      },
    });
  });

  it('tokens.css first-paint values are exactly Default Dark', () => {
    const declared = rootDeclarations();
    for (const token of COLOR_TOKENS) expect(declared[token], token).toBe(THEMES['default-dark'].colors[token]);
    THEMES['default-dark'].graph.forEach((c, i) => expect(declared[`graph-${i}`]).toBe(c));
  });

  it('tokens.css declares no colour a theme leaves out', () => {
    const themed = new Set<string>([...COLOR_TOKENS, ...Array.from({ length: 10 }, (_, i) => `graph-${i}`)]);
    const stray = Object.entries(rootDeclarations()).filter(([k, v]) => !themed.has(k) && /#[0-9a-f]{3,8}\b|rgba?\(/i.test(v));
    expect(stray).toEqual([]);
  });
});

describe('CSS uses theme tokens only', () => {
  const cssFiles = walk(SRC, /\.css$/);
  const declared = new Set<string>([...COLOR_TOKENS, ...Array.from({ length: 10 }, (_, i) => `graph-${i}`)]);
  for (const f of cssFiles) for (const m of readFileSync(f, 'utf8').matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1].slice(2));
  // Custom properties set from components as inline styles, e.g. RefLabels' '--lane-color', or from TS (density.ts).
  for (const f of walk(SRC, /\.tsx?$/)) for (const m of readFileSync(f, 'utf8').matchAll(/['"`]--([\w-]+)['"`]/g)) declared.add(m[1]);

  it('every var(--x) is declared by a theme, a stylesheet or an inline style', () => {
    const missing: string[] = [];
    for (const f of cssFiles) {
      for (const m of readFileSync(f, 'utf8').matchAll(/var\(\s*--([\w-]+)/g)) if (!declared.has(m[1])) missing.push(`${relative(SRC, f)}: --${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('no stylesheet except tokens.css hard-codes a color', () => {
    const offenders: string[] = [];
    for (const f of cssFiles) {
      if (f.endsWith(join('theme', 'tokens.css'))) continue;
      // Only declaration blocks: selectors like `#root` are not colors.
      for (const block of readFileSync(f, 'utf8').matchAll(/\{([^{}]*)\}/g)) {
        for (const line of block[1].split(';')) if (hardCodesColor(line)) offenders.push(`${relative(SRC, f)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the literal check catches every colour syntax, named colours included, and nothing else', () => {
    for (const d of ['color: #fff', 'background: rgb(0 0 0 / 0.4)', 'fill: hsl(0 0% 0%)', 'color: white', 'border: 1px solid Black', 'color: oklch(0.7 0.1 200)', 'color: lab(50 0 0)', 'color: hwb(0 0% 0%)', 'outline-color: red', 'background: color-mix(in srgb, grey 10%, transparent)']) {
      expect(hardCodesColor(d), d).toBe(true);
    }
    for (const d of ['white-space: nowrap', 'color: var(--red)', 'background: var(--blue, transparent)', 'color: currentColor', 'color: inherit', 'background: transparent', 'grid-template-areas: "a b"', 'color: var(--text-on-accent)', '/* theme-ok */ background: #000']) {
      expect(hardCodesColor(d), d).toBe(false);
    }
  });
});

const NAMED = /\b(white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|cyan|magenta|brown|gold|indigo|violet)\b|\b(hwb|lab|lch|oklab|oklch)\(|\bcolor\(/i;
/** A declaration that hard-codes a colour: hex, rgb()/hsl() and the other colour functions, or a named
 * colour in its value (custom property names and strings aside). `theme-ok` marks a deliberate one. */
function hardCodesColor(decl: string): boolean {
  if (decl.includes('theme-ok')) return false;
  if (/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(/.test(decl)) return true;
  const colon = decl.indexOf(':');
  if (colon < 0) return false;
  const value = decl.slice(colon + 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"|'[^']*'/g, '').replace(/--[\w-]+/g, '');
  return NAMED.test(value);
}
