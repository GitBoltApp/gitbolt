import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, '.fixtures.json'), 'utf8')) as {
  basic: string;
  unborn: string;
  longLabels: string;
  notRepo: string;
};
export const openUrl = (path: string) => `/?repo=${encodeURIComponent(path)}`;
