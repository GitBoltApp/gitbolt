// The website demo's data as a build publishes it (`vite build --mode demo`): each repo of the
// manifest gets `rev`, the first 12 hex digits of its bundle's SHA-256, and the published
// manifest gets one of its own, which the build compiles into the demo's code. The demo fetches
// `manifest.json?v=<rev>` and `<bundle>?v=<rev>`: GitHub Pages serves every file with a 10-minute
// cache and no way to change it, so new code never gets a cached older copy (docs/website.md).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PublishedData {
  /** The published manifest's own rev, built into the demo's code. */
  rev: string;
  /** The manifest as published: the committed one with each repo's `rev`. */
  manifest: string;
  /** The bundles it lists, in its order: the only ones published. */
  bundles: string[];
}

export const shortSha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

/** `dir`'s manifest and bundles as a build publishes them; null when it has no manifest. */
export function publishedData(dir: string): PublishedData | null {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { repos: { file: string; rev?: string }[] };
  const bundles: string[] = [];
  for (const repo of manifest.repos) {
    const file = join(dir, repo.file);
    if (!existsSync(file)) throw new Error(`demo data: ${repo.file} is in ${path} but not in ${dir}`);
    repo.rev = shortSha(readFileSync(file));
    bundles.push(repo.file);
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  return { rev: shortSha(text), manifest: text, bundles };
}
