// The landing page's own checks (build/check.ts): `node site/scripts/check-page.ts site/dist`, from
// the repo root. The whole Pages artefact is plan 6's ui/scripts/check-site.mjs (`just site-pages`).
import { readFileSync } from 'node:fs';
import { checkPage, expectedPlaceholders, PAGE_BUDGETS } from '../build/check.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const expected = expectedPlaceholders(read('../e2e-shots/shots.spec.ts'), read('../../ui/src/demo/coverage.ts'));
const { errors, warnings, budgets } = checkPage(process.argv[2] ?? 'site/dist', PAGE_BUDGETS, { expected });
for (const b of budgets) console.log(`check-page: ${b.name.padEnd(10)} ${String(b.actual).padStart(8)} of ${b.limit}`);
for (const w of warnings) console.warn(`check-page: warning: ${w}`);
for (const e of errors) console.error(`check-page: ${e}`);
if (errors.length) process.exit(1);
