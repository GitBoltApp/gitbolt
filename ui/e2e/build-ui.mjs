// Builds the UI the e2e suite serves (`vite build --mode e2e` into dist-e2e), unless the build
// there was made from the same inputs: the sources, the build config, the locked dependencies and
// the harness URL baked into it (VITE_GITBOLT_HARNESS). A run of one spec then starts in a second
// instead of waiting for a fresh build. GITBOLT_E2E_REBUILD=1 always rebuilds.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(ui, 'dist-e2e');
const stamp = join(out, '.build-key');

function* files(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const hash = createHash('sha256');
hash.update(`harness=${process.env.VITE_GITBOLT_HARNESS ?? ''}\n`);
for (const path of [...files(join(ui, 'src')), ...['index.html', 'vite.config.ts', 'package-lock.json', 'tsconfig.json'].map((f) => join(ui, f))]) {
  if (!existsSync(path)) continue;
  hash.update(`${relative(ui, path)}\n`);
  hash.update(readFileSync(path));
}
const key = hash.digest('hex');

if (!process.env.GITBOLT_E2E_REBUILD && existsSync(stamp) && readFileSync(stamp, 'utf8') === key) {
  console.log('e2e UI build is up to date (dist-e2e)');
} else {
  execFileSync('npx', ['vite', 'build', '--mode', 'e2e', '--outDir', 'dist-e2e', '--emptyOutDir', '--logLevel', 'warn'], { cwd: ui, stdio: 'inherit' });
  writeFileSync(stamp, key);
}
