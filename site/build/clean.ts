// The page's build empties site/dist/ except demo/, which `just demo-build` writes: the two builds
// can run in either order.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

export function emptyExceptDemo(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) if (name !== 'demo') rmSync(join(dir, name), { recursive: true, force: true });
}

export function keepDemo(): Plugin {
  let outDir = '';
  return {
    name: 'gitbolt-site-keep-demo',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      emptyExceptDemo(outDir);
    },
  };
}
