// `just demo-golden`: the website demo's parity data in ui/src/demo/golden/. For each fixture with
// a request list in requests/, the harness builds it, pack-demo.mjs compacts it in place and packs
// it into <fixture>.gbdemo, and the harness records the real core's answers to its requests on
// that same compacted folder (<fixture>/<n>.json). Also the core's default settings and profile
// (defaults.json) and a demo manifest over the bundles, so the folder doubles as demo data.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packFixture } from './pack-demo.mjs';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(ui, '..');
const targetDir = process.env.CARGO_TARGET_DIR ? (isAbsolute(process.env.CARGO_TARGET_DIR) ? process.env.CARGO_TARGET_DIR : join(repoRoot, process.env.CARGO_TARGET_DIR)) : join(repoRoot, 'target');
const harness = join(targetDir, 'debug', 'gitvolt-harness');
const golden = join(ui, 'src', 'demo', 'golden');
const requestsDir = join(golden, 'requests');
// basic first: the manifest's active tab. A `<fixture>@<scenario>.json` is a write scenario: a
// fresh copy of <fixture>, its answers and events in <fixture>@<scenario>/.
const stems = readdirSync(requestsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const fixtureOf = (stem) => stem.split('@')[0];
const fixtures = [...new Set(stems.map(fixtureOf))].sort((a, b) => Number(b === 'basic') - Number(a === 'basic') || (a < b ? -1 : 1));

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gitvolt-golden-')));
try {
  const packed = new Set();
  for (const stem of stems.sort()) {
    const name = fixtureOf(stem);
    const root = join(tmp, stem);
    const requests = join(requestsDir, `${stem}.json`);
    execFileSync(harness, ['fixture', name, root], { stdio: ['ignore', 'ignore', 'inherit'] });
    const bundle = packFixture(root, name, { inPlace: true });
    if (!packed.has(name)) {
      writeFileSync(join(golden, `${name}.gbdemo`), bundle);
      packed.add(name);
    }
    execFileSync(harness, ['golden', requests, name, root, join(golden, stem), ...(stem.includes('@') ? ['--events'] : [])], { stdio: 'inherit' });
    console.log(`${stem}: ${bundle.length} bytes, ${JSON.parse(readFileSync(requests, 'utf8')).length} answers`);
  }
  execFileSync(harness, ['golden-defaults', join(golden, 'defaults.json')], { stdio: 'inherit' });
  const manifest = {
    version: 1,
    repos: fixtures.map((name, i) => ({ name, file: `${name}.gbdemo`, group: i === 0 ? null : 'Playground', open: i === 0 ? 'active' : 'tab' })),
    groups: fixtures.length > 1 ? [{ name: 'Playground', color: 'blue', collapsed: true }] : [],
  };
  writeFileSync(join(golden, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
