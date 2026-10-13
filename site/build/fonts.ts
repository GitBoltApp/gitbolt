// The self-hosted fonts: their licenses in the build (OFL-1.1 asks for them beside the fonts), and
// preloads for the two faces the first screen paints with, so the headline doesn't reflow late.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export const FONT_PACKAGES = ['@fontsource/sora', '@fontsource/inter', '@fontsource/jetbrains-mono'] as const;
/** The headline's face and the body's. */
export const PRELOAD = ['sora-latin-800-normal', 'inter-latin-400-normal'] as const;

/** about.toml's `accepted`: the licenses GitBolt ships code under (docs/licensing.md). */
export function acceptedLicenses(aboutToml: string): string[] {
  const block = /^accepted\s*=\s*\[([\s\S]*?)^\]/m.exec(aboutToml)?.[1] ?? '';
  return [...block.matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]);
}

/** Each font package's name, version, license and license text; a license outside `accepted` fails. */
export function fontLicenses(root: string, accepted: readonly string[]): string {
  return FONT_PACKAGES.map((pkg) => {
    const dir = join(root, 'node_modules', pkg);
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: string };
    if (!meta.license || !accepted.includes(meta.license)) {
      throw new Error(`${pkg}: license ${meta.license ?? '(none)'} isn't in about.toml's accepted list (docs/licensing.md)`);
    }
    return `${meta.name} ${meta.version} (${meta.license})\n\n${readFileSync(join(dir, 'LICENSE'), 'utf8').trim()}\n`;
  }).join(`\n${'='.repeat(72)}\n\n`);
}

export function fonts(root: string, aboutTomlPath: string): Plugin {
  return {
    name: 'gitbolt-site-fonts',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'licenses/fonts.txt', source: fontLicenses(root, acceptedLicenses(readFileSync(aboutTomlPath, 'utf8'))) });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const files = Object.keys(ctx.bundle ?? {});
        const links = PRELOAD.map((face) => {
          const file = files.find((f) => f.includes(`/${face}-`) && f.endsWith('.woff2'));
          if (!file) throw new Error(`the build has no ${face}.woff2 to preload`);
          return `<link rel="preload" href="./${file}" as="font" type="font/woff2" crossorigin />`;
        });
        return html.replace('</head>', `    ${links.join('\n    ')}\n  </head>`);
      },
    },
  };
}
