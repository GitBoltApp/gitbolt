// The website demo's data in its build (`vite build --mode demo`): a data folder's manifest and
// bundles, served at /demo-data/ by the dev server, and published into the build's demo-data/
// with their revs (demoDataRev.ts), the manifest's built into the code as
// import.meta.env.VITE_GITBOLT_DEMO_DATA_REV; and the WebAssembly crates' notices, into its
// licenses/.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { type PublishedData, publishedData } from './demoDataRev.ts';

/** The files of `dir` the demo serves: its manifest and its bundles. */
export function demoDataFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f === 'manifest.json' || f.endsWith('.gbdemo')).sort();
}

/** Adds `name` to the licences list (`licenses/index.json`, as licenseNotices writes it) of `outDir`. */
export function addLicenseToIndex(outDir: string, name: string, size: number): void {
  const path = join(outDir, 'licenses', 'index.json');
  const index = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { files: { name: string; size: number }[] }) : { files: [] };
  index.files = [...index.files.filter((f) => f.name !== name), { name, size }];
  writeFileSync(path, JSON.stringify(index));
}

export function demoData(dir: string, wasmNotices: string): Plugin {
  let outDir = '';
  let published: PublishedData | null = null;
  return {
    name: 'gitbolt-demo-data',
    config(_config, env) {
      if (env.command !== 'build') return;
      published = publishedData(dir);
      return { define: { 'import.meta.env.VITE_GITBOLT_DEMO_DATA_REV': JSON.stringify(published?.rev ?? '') } };
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/demo-data', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
        if (!demoDataFiles(dir).includes(name)) {
          next();
          return;
        }
        res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        res.end(readFileSync(join(dir, name)));
      });
    },
    writeBundle() {
      if (published) {
        mkdirSync(join(outDir, 'demo-data'), { recursive: true });
        writeFileSync(join(outDir, 'demo-data', 'manifest.json'), published.manifest);
        for (const f of published.bundles) copyFileSync(join(dir, f), join(outDir, 'demo-data', f));
      }
      if (existsSync(wasmNotices)) {
        mkdirSync(join(outDir, 'licenses'), { recursive: true });
        copyFileSync(wasmNotices, join(outDir, 'licenses', 'THIRD-PARTY-NOTICES-wasm.txt'));
        addLicenseToIndex(outDir, 'THIRD-PARTY-NOTICES-wasm.txt', statSync(wasmNotices).size);
      }
    },
  };
}
