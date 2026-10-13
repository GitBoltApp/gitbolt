// Types for check-site.mjs, so TypeScript tests can import it.
export interface Budgets { bundles: number; demoCode: number; rawBinaries: number; image: number; site: number }
export const BUDGETS: Budgets;
export function checkSite(dist: string, opts?: { base?: string; root?: string; budgets?: Partial<Budgets> }): { errors: string[]; report: string[] };
