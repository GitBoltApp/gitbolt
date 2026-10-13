// Builds the demo the demo e2e suite serves (`vite build --mode demo` into dist-demo-e2e, with
// the parity suite's fixtures as its data), unless the build there was made from the same
// inputs: the sources (the WebAssembly and the golden data included), the pages, the build
// config and the locked dependencies. GITBOLT_E2E_REBUILD=1 always rebuilds.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(ui, 'dist-demo-e2e');
const stamp = join(out, '.build-key');
const data = join(ui, 'src', 'demo', 'golden');

function* files(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const hash = createHash('sha256');
for (const path of [...files(join(ui, 'src')), ...files(join(ui, 'build')), ...['index.html', 'demo.html', 'vite.config.ts', 'package-lock.json', 'tsconfig.json'].map((f) => join(ui, f))]) {
  if (!existsSync(path)) continue;
  hash.update(`${relative(ui, path)}\n`);
  hash.update(readFileSync(path));
}
const key = hash.digest('hex');

if (!process.env.GITBOLT_E2E_REBUILD && existsSync(stamp) && readFileSync(stamp, 'utf8') === key) {
  console.log('demo e2e build is up to date (dist-demo-e2e)');
} else {
  execFileSync('npx', ['vite', 'build', '--mode', 'demo', '--outDir', 'dist-demo-e2e', '--emptyOutDir', '--logLevel', 'warn'], { cwd: ui, stdio: 'inherit', env: { ...process.env, GITBOLT_DEMO_DATA: data } });
  writeFileSync(stamp, key);
}
