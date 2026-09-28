import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

// Resolved relative to this file (not process.cwd()) so playwright.config.ts and every e2e
// script agree on the harness binary's location no matter where `playwright test` is invoked
// from.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
// Honour CARGO_TARGET_DIR when the harness was built with one set (e.g. a target dir shared
// across worktrees), falling back to the repo's own `target`. A relative CARGO_TARGET_DIR is
// resolved against the repo root, matching where `cargo build` is run from.
const targetDir = process.env.CARGO_TARGET_DIR
  ? (isAbsolute(process.env.CARGO_TARGET_DIR) ? process.env.CARGO_TARGET_DIR : join(repoRoot, process.env.CARGO_TARGET_DIR))
  : join(repoRoot, 'target');
export const HARNESS_BIN = join(targetDir, 'debug', 'gitbolt-harness');
