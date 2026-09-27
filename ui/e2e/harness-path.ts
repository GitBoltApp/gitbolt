import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolved relative to this file (not process.cwd()) so playwright.config.ts and every e2e
// script agree on the harness binary's location no matter where `playwright test` is invoked
// from.
const here = dirname(fileURLToPath(import.meta.url));
export const HARNESS_BIN = join(here, '..', '..', 'target', 'debug', 'gitbolt-harness');
