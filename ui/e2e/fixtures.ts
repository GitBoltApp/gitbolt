import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, '.fixtures.json'), 'utf8')) as {
  basic: string;
  unborn: string;
  longLabels: string;
  wide: string;
  details: string;
  longHistory: string;
  diffView: string;
  notRepo: string;
};
export const openUrl = (path: string) => `/?repo=${encodeURIComponent(path)}`;
/** The harness's HTTP side (same port rule as playwright.config.ts): `GET /launches` lists the
 * "Open in…" launches it recorded instead of running. */
export const harnessHttp = `http://127.0.0.1:${process.env.GITBOLT_E2E_PORT_BASE ? Number(process.env.GITBOLT_E2E_PORT_BASE) : 7433}`;
