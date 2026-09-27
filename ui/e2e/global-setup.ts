import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_BIN } from './harness-path';

export default function globalSetup() {
  const root = mkdtempSync(join(tmpdir(), 'gitbolt-e2e-'));
  const make = (name: string) =>
    execFileSync(HARNESS_BIN, ['fixture', name, join(root, name)], { encoding: 'utf8' }).trim();
  const fixtures = { basic: make('basic'), unborn: make('unborn'), longLabels: make('long_labels'), notRepo: root };
  writeFileSync(join(import.meta.dirname, '.fixtures.json'), JSON.stringify(fixtures));
  return () => rmSync(root, { recursive: true, force: true });
}
